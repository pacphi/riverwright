# Riverwright

Approval-gated agent toolkit for the open-source projects you depend on. It reproduces a bug in an upstream dependency, fixes it, proposes the pull request, then watches the thread until the fix ships and helps you drop your workaround.

> **Status: design and early implementation. Not ready to use yet.** Names and interfaces will change.

## What it is meant to do

- Reproduce an upstream bug in a sealed workspace and prove it with a failing test.
- Fix it with the smallest change and check it against the project's own tests and contribution rules.
- Send the pull request only after you approve the exact commit.
- Follow the thread until the fix is released, then help you adopt it and keep the conversation friendly.

It is designed to work with Claude Code, Codex CLI, Gemini CLI, Cursor, Grok Build and Hermes Agent.

## Documentation

Start with the [documentation map](docs/README.md) and the [roadmap](docs/ROADMAP.md), which lists every use case and feature with its status.

## Command

`riverwright`, with the short alias `rw`.

## License

[MIT](LICENSE)
