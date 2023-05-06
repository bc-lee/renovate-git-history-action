import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as core from "@actions/core"
import * as exec from "@actions/exec"

export interface GitUpdate {
  url: string
  oldSha: string
  newSha: string
}

interface PackageUpdate {
  package?: string
  update?: string
  change?: string
}

// Example data for the body is as follows:
/*
This PR contains the following updates:

| Package | Update | Change |
|---|---|---|
| https://chromium.googlesource.com/chromium/src/third_party/boringssl | digest | `6d1223d3c51f79fe044ba3837cbd495d0bd54740` -> `124d8d6d4967573d4cea2d99d612c0686c8f283a` |

---
 */
export async function parseTable(body: string): Promise<GitUpdate[] | null> {
  // Find table
  const headerRegex = /\| Package \| Update \| Change \|/i
  const table = body.match(headerRegex)
  if (!table) {
    return null
  }

  const tableStart = body.indexOf(table[0])
  const tableEnd = body.indexOf("\n\n", tableStart)

  // Parse table to json object
  const tableBody = body.substring(tableStart, tableEnd)
  const tableRows = tableBody.split("\n")
  const tableHeader = tableRows[0].split("|").map(s => s.trim())
  const tableData = tableRows.slice(2).map(row => {
    return row.split("|").map(s => s.trim())
  })

  const updates: PackageUpdate[] = []
  for (const row of tableData) {
    const update: PackageUpdate = {}
    for (let i = 0; i < row.length; i++) {
      const header = tableHeader[i].toLowerCase()
      const value = row[i]
      if (header === "package") {
        update.package = value
      } else if (header === "update") {
        update.update = value
      } else if (header === "change") {
        update.change = value
      }
    }
    updates.push(update)
  }

  // Filter only for digest changes
  const digestUpdates = updates.filter(update => {
    return update.update === "digest"
  })

  // Parse change field to split old and new sha
  const gitUpdates: GitUpdate[] = []
  for (const update of digestUpdates) {
    const packageName = update.package
    const change = update.change
    if (!packageName || !change) {
      continue
    }
    const changeShaRegex = /`([0-9a-f]{7,40})` -> `([0-9a-f]{7,40})`/
    const changeSha = change.match(changeShaRegex)
    if (!changeSha) {
      continue
    }
    const oldSha = changeSha[1]
    const newSha = changeSha[2]
    gitUpdates.push({
      url: packageName,
      oldSha,
      newSha
    })
  }
  return gitUpdates
}

export async function getGitHistoryDescription(
  gitUpdate: GitUpdate
): Promise<String> {
  const url = gitUpdate.url.replace(/\/$/, "").replace(/\.git$/, "")
  const oldSha = gitUpdate.oldSha
  const newSha = gitUpdate.newSha

  // First, make a temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-history-"))
  // Cleanup on exit
  try {
    // I don't like nested try/catch blocks, but it is necessary.
    try {
      // clone into the temp directory
      await execGit(["clone", url, tempDir])
    } catch (error) {
      const msg = `Failed to clone ${url}: ${error}`
      core.warning(msg)
      return msg
    }

    // Get short SHA
    const oldShortSha = await execGitWithStdout(
      ["rev-parse", "--short", oldSha],
      tempDir
    )

    const newShortSha = await execGitWithStdout(
      ["rev-parse", "--short", newSha],
      tempDir
    )

    // Get long SHA
    let oldLongSha = ""
    try {
      oldLongSha = await execGitWithStdout(["rev-parse", oldSha], tempDir)
    } catch (error) {
      const msg = `Failed to get long sha for ${oldSha}: ${error}`
      core.warning(msg)
      return msg
    }
    const newLongSha = await execGitWithStdout(["rev-parse", newSha], tempDir)

    let log: string[] = []
    try {
      log = (
        await execGitWithStdout(
          [
            "log",
            "--date=format:%Y-%m-%d",
            "--format=%H %h %ad %ae %s",
            `${oldLongSha}..${newLongSha}`
          ],
          tempDir
        )
      )

        .split("\n")
        .filter(line => line.length > 0)
    } catch (error) {
      const msg = `Failed to get git log: ${error}`
      core.warning(msg)
      return msg
    }

    interface GitEntry {
      hash: string
      shortHash: string
      date: string
      email: string
      subject: string
    }

    const gitEntries: GitEntry[] = []
    for (const line of log) {
      const parts = line.split(" ")
      const hash = parts[0]
      const shortHash = parts[1]
      const date = parts[2]
      const email = parts[3]
      const subject = parts.slice(4).join(" ")
      gitEntries.push({
        hash,
        shortHash,
        date,
        email,
        subject
      })
    }

    let resultString = ""

    // Add a link for the diff
    let diffDescription = ""
    let diffLink = ""
    let clickableLink = ""
    let isClickable = false
    if (url.includes("github.com")) {
      // Github example: https://github.com/renovatebot/renovate/compare/44f22984ddaafe2fceae4965076d7cdb26bcd716...f9f52a5dec1d7883b17dd9ce0ce0e15bd6997ad7
      diffDescription = `${url}/compare/${oldShortSha}...${newShortSha}`
      diffLink = `${url}/compare/${oldLongSha}...${newLongSha}`
      clickableLink = `${url}/commit/`
      isClickable = true
    } else if (url.includes("googlesource.com")) {
      // googlesource example: https://chromium.googlesource.com/chromium/tools/build.git/+log/b13c438aadd44834c675b94a3eb51e9b32eb7bfa..b13c438aadd44834c675b94a3eb51e9b32eb7bfa
      diffDescription = `${url}/+log/${oldShortSha}..${newShortSha}`
      diffLink = `${url}/+log/${oldLongSha}..${newLongSha}`
      clickableLink = `${url}/+/`
      isClickable = true
    } else {
      core.warning(`Unknown git url: ${url}`)
      diffDescription = `${url} ${oldSha}..${newSha}`
    }

    if (isClickable) {
      resultString += `- [${diffDescription}](${diffLink})\n\n`
    } else {
      resultString += `- ${diffDescription}\n\n`
    }

    resultString += "<details><summary>Details</summary>\n\n"

    for (const entry of gitEntries) {
      if (clickableLink) {
        resultString += `[${entry.shortHash}](${clickableLink}${entry.hash}) ${entry.date} ${entry.email} ${entry.subject}\n`
      } else {
        resultString += `${entry.shortHash} ${entry.date} ${entry.email} ${entry.subject}\n`
      }
    }
    resultString += "</details>\n\n"

    return resultString
  } finally {
    fs.rmSync(tempDir, {recursive: true, force: true})
  }
}

function sanitizeEnvs(): {[key: string]: string} {
  const env: {
    [key: string]: string
  } = {}
  for (const key in process.env) {
    const value = process.env[key]
    if (value != null) {
      env[key] = value
    }
  }

  // We need to parse dates, so we need to reset the locale and timezone.
  env["LANG"] = "C.UTF-8"
  env["LC_ALL"] = "C.UTF-8"
  env["TZ"] = "UTC"
  return env
}

async function execGit(
  args: string[],
  workingDirectory?: string
): Promise<null> {
  await exec.exec("git", args, {
    cwd: workingDirectory,
    env: sanitizeEnvs()
  })
  return null
}

async function execGitWithStdout(
  args: string[],
  workingDirectory?: string
): Promise<string> {
  let result = ""
  await exec.exec("git", args, {
    cwd: workingDirectory,
    env: sanitizeEnvs(),
    listeners: {
      stdout: (data: Buffer) => {
        result += data.toString()
      }
    }
  })
  return result.trimEnd()
}
