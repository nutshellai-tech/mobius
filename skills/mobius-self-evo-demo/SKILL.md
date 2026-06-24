---
name: mobius-self-evo-demo
description: Produce a Mobius self-evolution demo video for requests that ask to show an existing UI, submit the same requirement to the Xiao Mo assistant, implement the requirement, record the changed UI, concatenate the clips, and deliver an MP4. Use for Mobius self-iteration demo-video tasks based on Playwright, especially Issue/Session flows that mention "自进化演示视频", "基于 Playwright", "录制视频", or three-part before/request/after demonstrations.
---

# Mobius Self-Evolution Demo Video

Use this skill to create a reproducible Mobius self-evolution demo:

1. Record the current UI before the change.
2. Record the user requirement being typed into Xiao Mo.
3. Implement the requirement.
4. Record the changed UI.
5. Insert animated transition title cards between the clips.
6. Concatenate the clips and convert the final video to MP4.

## Required Rules

- Do not use git worktree in this project.
- After a Mobius code-change batch is ready, commit all workspace changes, then run `python3 start.py` so PM2 serves the new code.
- Before recording the after-state clip, confirm `python3 start.py` has been run after the implementation commit.
- Use commit messages in the form `中文代码变动说明 (English code change summary)`.
- Ensure `git config user.email` is `mobius_os@163.com`.
- At final success or failure, remove the Session marker `running.flag` specified by the task context.
- Do not revert unrelated user/concurrent changes. If unrelated files change while working, inspect them, work with them, and commit according to project rules.

## Find the Target

1. Confirm the Mobius service URL from health, not from port guesses:

   ```bash
   curl -sS http://localhost:45616/api/v2/health
   ```

   The Playwright dev-server detector may list common ports such as `3000`,
   `3001`, `5173`, or `8000` and miss the production Mobius port `45616`.

2. Login through `/api/auth/login`. Password login may be disabled:

   ```js
   const { request } = require('playwright');
   const api = await request.newContext({ baseURL: 'http://localhost:45616' });
   const res = await api.post('/api/auth/login', { data: { username: 'user' } });
   const { token } = await res.json();
   ```

3. Locate the self-develop project by API or known project knowledge. For this
   repo, the self-develop project commonly has `bind_path = /home/user/imac-test`
   and route shape:

   ```text
   /u/<userId>/p/<projectId>
   ```

## Record With Playwright

Use the project Playwright skill if present. Scripts should live under `/tmp`,
not inside the repo. Playwright's `recordVideo` produces WebM clips; keep these
raw clips and later convert the final output to MP4.

Prefer `headless: true` when no reliable display is available. Headful Chromium
can hang on stale X11 sockets; headless recording is still a valid browser
automation recording.

Use a stable viewport:

```js
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: '/tmp/imac-demo-video/raw', size: { width: 1440, height: 900 } },
});
await context.addInitScript((value) => {
  localStorage.setItem('cc-token', value);
  localStorage.setItem('cc-background-flow', '0');
}, token);
```

Save each clip explicitly:

```js
const video = page.video();
await context.close();
await video.saveAs('/tmp/imac-demo-video/part1-before.webm');
await browser.close();
```

## Clip 1: Before State

1. Open the target project route.
2. Wait for `[data-tour="project-settings-panel"]`.
3. Click the relevant tab, for example `版本追踪`.
4. Record the current control state for a few seconds.
5. Do not modify data in this clip.

For the version-tracking demo, verify the old state shows `刷新` but no Git
operation menu.

## Clip 2: Xiao Mo Requirement

1. Open the same project route.
2. Click `[data-testid="assistant-bubble"]`.
3. Wait for `[data-testid="assistant-panel"]`.
4. Type the requirement one character at a time:

   ```js
   await page.getByTestId('assistant-input').type(REQUIREMENT, { delay: 45 });
   ```

5. Click the assistant send button.
6. Wait 3 seconds and stop.

Do not click any second confirmation or execution prompt inside Xiao Mo. The
goal is to demonstrate the user submitting the requirement, not to let Xiao Mo
perform the implementation during the recording.

## Implement the Requirement

Follow existing code patterns and keep the change narrow. For a UI capability
inside the project settings panel, likely files are:

- `mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx`
- `mobius/backend/routes/projects.js`

For backend Git operations:

- Use a whitelist of supported actions. Do not accept arbitrary Git args from
  the client.
- Reuse the existing project bind-path and Git repository discovery logic.
- Require project management permission for mutating Git operations.
- Return refreshed tracking data after the action.

For frontend menus:

- Only show Git operation controls when `gitTracking.available` is true.
- Use icon buttons and menus, not text-only ad hoc controls.
- Keep the demo safe: in the after-video, show the menu and hover options; do
  not execute `pull`, `push`, or `stage` unless the task explicitly asks to test
  a specific action.

Validate before recording the after state:

```bash
node -c mobius/backend/routes/projects.js
cd mobius/frontend && npm run build
python3 start.py
curl -sS http://localhost:45616/api/v2/health
```

If testing the new Git route, use an invalid action such as `noop` to verify
the route is mounted without mutating the repository.

## Clip 3: After State

1. Open the target project route after `python3 start.py`.
2. Navigate to the changed UI.
3. Wait for the new control selector, not only visible text. Example:

   ```js
   await page.waitForFunction(() => {
     const panel = document.querySelector('[data-tour="project-settings-panel"]');
     return !!panel
       && (panel.textContent || '').includes('近期 commits')
       && !!panel.querySelector('button[aria-label="Git 操作"]');
   });
   ```

4. Open the new menu.
5. Hover the expected options so the video clearly shows them.
6. Capture a screenshot of the final frame for quick inspection.

## Concatenate And Convert To MP4

Always deliver MP4. Keep WebM intermediates if useful, but the final shared
artifact should be MP4.

Always insert two animated transition title cards between the three recorded
clips. The title cards must not be static black frames. Use a moving gradient or
motion background, fading text, and slight text movement/scale so the transition
feels deliberate:

- Between clip 1 and clip 2:
  `接下来，我们给小莫提出需求，提出需求`
- Between clip 2 and clip 3:
  `小莫会处理您的指令……等待享用一杯咖啡的时间后……`

Prefer the bundled renderer because the local static `ffmpeg` may not include
the `drawtext` filter, and `xfade` can fail when an input loses constant-frame-
rate metadata. The renderer uses ASS subtitles for dynamic text effects,
moving gradient backgrounds, internal fades, and normalized MP4 concatenation:

```bash
python3 skills/mobius-self-evo-demo/scripts/render_demo_video.py \
  --work-dir /tmp/imac-demo-video \
  --part1 /tmp/imac-demo-video/part1-before.webm \
  --part2 /tmp/imac-demo-video/part2-request.webm \
  --part3 /tmp/imac-demo-video/part3-after.webm \
  --output .imac/generated_videos/<session-or-flag-id>/self-evolution-demo.mp4
```

The renderer creates:

- `transition1-animated.mp4`
- `transition2-animated.mp4`
- the final `self-evolution-demo.mp4`

Only fall back to manual concatenation when the renderer is unavailable.

Create a concat list:

```text
file '/tmp/imac-demo-video/part1-before.webm'
file '/tmp/imac-demo-video/part2-request.webm'
file '/tmp/imac-demo-video/part3-after.webm'
```

Concatenate to a combined WebM:

```bash
ffmpeg -y -f concat -safe 0 \
  -i /tmp/imac-demo-video/concat.txt \
  -c copy /tmp/imac-demo-video/self-evolution-demo.webm
```

Convert the final video to MP4:

```bash
ffmpeg -y -i /tmp/imac-demo-video/self-evolution-demo.webm \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  /tmp/imac-demo-video/self-evolution-demo.mp4
```

Copy the MP4 into a persistent project artifact directory:

```bash
mkdir -p .imac/generated_videos/<session-or-flag-id>
cp /tmp/imac-demo-video/self-evolution-demo.mp4 \
  .imac/generated_videos/<session-or-flag-id>/self-evolution-demo.mp4
```

If an older run already produced only a WebM artifact, transcode that WebM and
store the MP4 next to it before reporting completion.

If concat copy fails because clips have incompatible stream parameters,
transcode directly:

```bash
ffmpeg -y -f concat -safe 0 \
  -i /tmp/imac-demo-video/concat.txt \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  /tmp/imac-demo-video/self-evolution-demo.mp4
```

## Verify Video

`ffprobe` may not be installed. Use `ffmpeg` for decode validation:

```bash
ffmpeg -i /tmp/imac-demo-video/self-evolution-demo.mp4 -f null -
```

Extract and inspect a final frame:

```bash
ffmpeg -y -sseof -2 \
  -i /tmp/imac-demo-video/self-evolution-demo.mp4 \
  -update 1 -vframes 1 /tmp/imac-demo-video/final-last-frame.png
```

Use `view_image` or `display_images` to confirm the final frame shows the
after-state UI.

## Lessons From Prior Run

- Browser display: `DISPLAY` can be empty while stale X11 sockets exist. A
  smoke test may pass once and later headful launch can hang. Prefer headless
  Playwright recording for reliability unless a visible browser is truly needed.
- Video effects: the local static `ffmpeg` may have `ass`, `gradients`, and
  `xfade` but no `drawtext`. Prefer ASS subtitle animation for Chinese title
  cards. If `xfade` rejects inputs as non-constant-frame-rate, use animated
  transition clips with normalized concat instead of installing another ffmpeg
  build.
- Service discovery: automated dev-server detection can miss Mobius production
  port. Trust `/api/v2/health`.
- Selectors: aria labels are not body text. Wait for selectors such as
  `button[aria-label="Git 操作"]` instead of waiting for text that is only in an
  attribute.
- Route testing: verify dangerous routes with invalid/no-op input first.
- Concurrent edits: README or other files may be modified by another session.
  Do not revert them. Inspect, wait briefly if the file is actively changing,
  then commit according to the project rule.
- Git status: check `git status --short` before and after every commit/start
  cycle.
- Final cleanup: remove `running.flag` only after implementation, videos,
  validation, commits, and service update are complete.
