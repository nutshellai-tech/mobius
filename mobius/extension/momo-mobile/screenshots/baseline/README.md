# Simulator screenshot baselines

The first successful GitHub Actions run uploads a `baseline-candidates-<run-id>`
artifact containing:

- `android.png`
- `ios.png`

Review both images, then commit them to this directory. Later pull requests
compare screenshots against these files and fail when more than 5% of pixels
change.

Desktop Preview screenshots are not valid Android or iOS baselines.
