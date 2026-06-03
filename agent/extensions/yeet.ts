import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const YEET_PROMPT = `Commit and push the current repository changes.

Steps:
1. Add all unstaged changes with \`git add -A\`.
2. Run \`git diff --cached\` and scan the staged diff for sensitive content before doing anything else:
   - Patterns to flag: API keys, tokens, secrets, passwords, private keys, hardcoded credentials, .env values, auth tokens.
   - Common patterns: strings matching \`sk-\`, \`pk-\`, \`Bearer \`, \`Authorization:\`, \`-----BEGIN\`, \`password=\`, \`secret=\`, \`token=\`, \`api_key=\` (case-insensitive).
   - If anything suspicious is found: stop, show exactly what was flagged and where, and ask the user whether to continue or abort.
   - If nothing suspicious is found: proceed silently.
3. Inspect the staged changes and write a concise commit message that accurately summarizes them.
4. Commit the changes with that message.
5. Push the commit to the current branch's remote.
   - If the current branch does not have an upstream remote branch, create one by pushing with upstream tracking.
   - If this repository has no git remotes configured, do not push.
6. After pushing, output the remote URL for what was pushed if the repository has a remote.
   - If the current branch is \`main\`, output the normal remote repository URL.
   - If the current branch is not \`main\`, output a URL to create a pull request from the pushed branch into \`main\`.
   - Convert SSH git remotes like \`git@github.com:owner/repo.git\` to HTTPS URLs when printing.

Keep the commit message concise.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Add, commit, and push the current repo changes",
    handler: async (args, ctx) => {
      const prompt = args?.trim()
        ? `${YEET_PROMPT}\n\nAdditional instructions from the user:\n${args.trim()}`
        : YEET_PROMPT;

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /yeet as a follow-up", "info");
      }
    },
  });
}
