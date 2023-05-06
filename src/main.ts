import * as core from "@actions/core"
import * as fs from "fs"
import {Octokit} from "@octokit/core"
import {getGitHistoryDescription, parseTable} from "./util"

async function run(): Promise<void> {
  try {
    // load event.json
    const eventPath = process.env.GITHUB_EVENT_PATH as string
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"))

    // check if we are in the pull_request event
    if (!event.pull_request) {
      core.setFailed("No pull request found.")
      return
    }

    // Get PR number, body
    // const prNumber = event.pull_request.number
    // const prTitle = event.pull_request.title
    const prBody = event.pull_request.body

    // check if this PR is created by renovate bot
    // It may contain "Renovate Bot" or "renovate[bot]"
    const regex = /renovate(\s|\[bot])/i
    if (!regex.test(prBody)) {
      core.info("This PR is not created by renovate bot.")
      return
    }

    const gitUpdates = await parseTable(prBody)
    if (!gitUpdates) {
      core.info("No updates found.")
      return
    }

    core.info("Found updates for the following packages:")
    core.info(gitUpdates.map(update => update.url).join("\n"))

    // Now, create comment message for each git update
    let description = ""
    for (const gitUpdate of gitUpdates) {
      description += await getGitHistoryDescription(gitUpdate)
    }

    // Create a comment on the PR
    const octokit = new Octokit({auth: process.env.GITHUB_TOKEN})
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: event.repository.owner.login,
        repo: event.repository.name,
        issue_number: event.pull_request.number,
        body: description
      }
    )
    core.info("Comment created.")
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
