import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as core from "@actions/core"
import * as sgit from "simple-git"

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

### Configuration

📅 **Schedule**: Branch creation - At any time (no schedule defined), Automerge - At any time (no schedule defined).

🚦 **Automerge**: Disabled by config. Please merge this manually once you are satisfied.

♻ **Rebasing**: Whenever PR becomes conflicted, or you tick the rebase/retry checkbox.

🔕 **Ignore**: Close this PR and you won't be reminded about this update again.

---

 - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box

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

  // clone into the temp directory
  const git = sgit.simpleGit({
    baseDir: tempDir
  })
  try {
    await git.clone(url, ".")
  } catch (e) {
    const msg = `Failed to clone ${url}: ${e}`
    core.warning(msg)
    return msg
  }

  // Get short sha
  const oldShortSha = await git.revparse(["--short", oldSha])
  const newShortSha = await git.revparse(["--short", newSha])

  // Get long sha
  let oldLongSha = ""
  try {
    oldLongSha = await git.revparse(oldSha)
  } catch (e) {
    const msg = `Failed to get long sha for ${oldSha}: ${e}`
    core.warning(msg)
    return msg
  }
  const newLongSha = await git.revparse(newSha)

  let log: sgit.LogResult<string>
  try {
    log = await git.log({
      from: oldLongSha,
      to: newLongSha,
      date: "format:%Y-%m-%d",
      format: "%H %h %ad %ae %s"
    })
  } catch (e) {
    const msg = `Failed to get git log: ${e}`
    core.warning(msg)
    core.warning(e.stack)
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
  for (const line of log.all) {
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

  // Add a link for diff
  // Example
  // - Github: https://github.com/renovatebot/renovate/compare/44f22984ddaafe2fceae4965076d7cdb26bcd716...f9f52a5dec1d7883b17dd9ce0ce0e15bd6997ad7
  // - googlesource: https://chromium.googlesource.com/chromium/tools/build.git/+log/6804deb78db2..329766fab495

  let diffDescription = ""
  let diffLink = ""
  let clickableLink = ""
  let isClickable = false
  if (url.includes("github.com")) {
    diffDescription = `${url}/compare/${oldShortSha}...${newShortSha}`
    diffLink = `${url}/compare/${oldSha}...${newSha}`
    clickableLink = `${url}/commit/`
    isClickable = true
  } else if (url.includes("googlesource.com")) {
    diffDescription = `${url}/+log/${oldShortSha}..${newShortSha}`
    diffLink = `${url}/+log/${oldSha}..${newSha}`
    clickableLink = `${url}/+/`
    isClickable = true
  } else {
    diffDescription = `${url} ${oldSha}..${newSha}`
  }

  if (isClickable) {
    resultString += `- [${diffDescription}](${diffLink})\n\n`
  } else {
    resultString += `- ${diffDescription}\n\n`
  }

  // Add git log
  // Example
  // [abcdefg](https://chromium.googlesource.com/chromium/tools/build.git/+/b13c438aadd44834c675b94a3eb51e9b32eb7bfa) 2023-05-05 bsheedy@chromium Update dawn_top_of_tree config

  for (const entry of gitEntries) {
    if (clickableLink) {
      resultString += `[${entry.shortHash}](${clickableLink}${entry.hash}) ${entry.date} ${entry.email} ${entry.subject}\n`
    } else {
      resultString += `${entry.shortHash} ${entry.date} ${entry.email} ${entry.subject}\n`
    }
  }

  return resultString
}
