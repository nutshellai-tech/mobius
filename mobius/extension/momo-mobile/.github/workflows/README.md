# Workflow location

GitHub only discovers workflows from the repository-level
`.github/workflows/` directory. The executable workflow for this extension is:

```text
/.github/workflows/momo-mobile-screenshot-verify.yml
```

It is kept at repository level for GitHub compatibility while all scripts,
XcodeGen configuration, screenshots and documentation remain inside
`mobius/extension/momo-mobile/`.
