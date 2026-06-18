Commit and push the current repository changes.

Steps:
1. Add all unstaged changes with `git add -A`.
2. Run `git diff --cached` and scan the staged diff for sensitive content before doing anything else:
   - Patterns to flag: API keys, tokens, secrets, passwords, private keys, hardcoded credentials, .env values, auth tokens.
   - Common patterns: strings matching `sk-`, `pk-`, `Bearer `, `Authorization:`, `-----BEGIN`, `password=`, `secret=`, `token=`, `api_key=` (case-insensitive).
   - If anything suspicious is found: stop, show exactly what was flagged and where, and ask the user whether to continue or abort.
   - If nothing suspicious is found: proceed silently.
3. Inspect the staged changes and write a concise commit message that accurately summarizes them.
4. Commit the changes with that message.
5. Before pushing, if the current branch is not `main`, check whether an open pull request already exists for this branch.
   - Use `gh pr list --head <branch> --state open` (or `gh pr view <branch>`) if the `gh` CLI is available.
   - If an open PR already exists, note its URL and reuse it later instead of printing a "create PR" link.
   - If `gh` is not available, skip this check silently.
6. Push the commit to the current branch's remote.
   - If the current branch does not have an upstream remote branch, create one by pushing with upstream tracking.
   - If this repository has no git remotes configured, do not push.
7. After pushing, output the remote URL for what was pushed if the repository has a remote.
   - If the current branch is `main`, output the normal remote repository URL.
   - If the current branch is not `main` and an open PR already exists (from step 5), output that existing PR's URL.
   - If the current branch is not `main` and no PR exists, output a URL to create a pull request from the pushed branch into `main`.
   - Convert SSH git remotes like `git@github.com:owner/repo.git` to HTTPS URLs when printing.

If the user passed extra instructions after the command, treat them as additional constraints for this ship.

Keep the commit message concise.
