# Mocks on visual plans (Antigravity reference)

Read this file only when the plan has existing mocks. With no mocks, skip it and say nothing about mocks.

## What counts

A mock is a picture of a screen, page, dialog or email the plan will build. Mocks that already exist go on the canvas next to the tasks that build them. This skill never makes one (no shapes, no generated picture, no new mock page) and never adds a task to place, finish or build a mock.

Only mocks this conversation made, or that the user attached, showed or named, or that a plan the user gave names count. When you draft the plan yourself, pictures you came across while exploring do not count. Never search the disk or the repository for pictures.

- A picture file: PNG, JPEG, WebP or GIF.
- An `https` link to such a picture (the picture itself, not a web page around it).
- An HTML mock page, which needs a screenshot first (below).
- A mocks canvas already on Unpaged. Its pictures cannot be copied, so put its link, once, on the first phase canvas it has screens for (read it with `document_get` when its title does not say; the root of a single-phase plan), as a `text` element: `[Mocks: <its title, with [ and ] escaped>](https://unpaged.io/document/<id>/edit)`. It needs no picture tools.

A picture that reached the conversation with no file path or link (pasted into the chat, or a screenshot a tool only showed) cannot be added: leave it out and say so. When the conversation holds several versions of a mock, use the one the user approved, else the latest; never an option the user turned down.

## Adding the pictures (right after step 1, before drawing any canvas)

- For a link: `image_import({ documentId, url })`.
- For a file: `image_upload_link_create({ documentId })`, then run the command its reply gives, with the file's path in place of `<file>`. It sends the file with the link's token in the `Authorization` header. One link per file; a link works once, for ten minutes. Never write the token anywhere but that command: not in a URL, a file, a command's description or your reply.
- `image_import` and the upload command's output answer `pictureKey`, `naturalWidth` and `naturalHeight`: keep them for steps 2 and 3.
- For an HTML mock page: ask for the first upload link before taking any screenshot, so an account that cannot add pictures launches no browser; once it is granted, take the page's screenshots, then upload the first with the link already granted and each other with a new link. Use only a browser this session already has that writes the PNG to an absolute path you give (a Playwright tool, or a headless browser from the shell), never one you install for this. Shoot each screen on its own (an element screenshot, or a full-page shot cropped to its region) at the page's own width and 1x scale, into a temporary folder outside the repository. Look at each screenshot before uploading it: retake a blank or cut-off one once, by any method, then leave it out. Delete every file you made for a screenshot once it is uploaded or left out. When this session cannot take a screenshot, leave that mock out and say so.

## Best-effort error & sandbox rules

Mocks are best-effort and never block the render, like folder filing:

- If the connected server offers no picture tools, or a refusal is about the account rather than the picture (Premium, an unconfirmed email, a daily or per-whiteboard limit, too many unused upload links, pictures switched off), stop adding pictures, place the ones already added, draw the plan (a link to a mocks canvas still goes on), and say in one sentence which mocks are not on the canvas and why, using the server's reason. For Premium: *"Putting mock pictures on a plan needs Premium on your Unpaged account, so this one is drawn without them."*
- If one picture fails (another format, too large, damaged, a link that could not be fetched), leave that one out, carry on, and name it in one sentence. When an upload link expired before the file went, call `image_upload_link_create` once more for that file.
- If the upload command or a headless browser fails with a network or permission error in Standard Sandbox Mode, re-run it once with `BypassSandbox: true`. If that is declined or still fails, or the user refuses a mock's own step (a screenshot, `image_import`, `image_upload_link_create` or the upload command), do not retry it: leave that mock out and say so.

## Placing mocks on phase canvases (step 2) and single-phase roots (step 3)

- **Always place mocks in a separate `batch_create_elements`** once the phase canvas (`node_create_with_elements`) or single-phase root batch (`batch_create_elements`) has succeeded, so a refused picture never costs a phase its tasks or costs a single-phase overview its status stamp and links.
- **Which canvas:** on a multi-phase plan, put each mock on the canvas of the phase whose tasks build the screen or part it shows; when several phases build it, the first of them; when none clearly does, the first phase. On a small single-phase plan, put them on the root to the right of or below the checklist, never level with the bottom scaffolding dock row (the `as-built` skill puts its record links along that dock row, one after another).
- **Element fields & layout:** place each as an `image` element (`pictureKey`, `naturalWidth` and `naturalHeight` exactly as answered; `width` alone, so the height follows, never wider than its natural width; `description` saying what it shows) to the right of the checklist and cards, or below them, whichever leaves it more width, never over them, with a one-line `text` caption beneath it naming what it shows (*Mock: people list, desktop*), never a local file path. Outline a mock with a white edge: after it, a `rectangle` of its size (height = width × `naturalHeight` ÷ `naturalWidth`), `fillColor: "none"`, `strokeColor: "#cbd5e1"`, `strokeWidth: 1`. Shrink a mock to no less than half its natural width; when the mocks still do not fit, enlarge the canvas with `node_update` first.
- **Retry on batch refusal:** if the mock placement batch is refused, send it once more: with the field it names fixed, after a moment when it says so, or without a picture it refuses. Name every mock left out in one sentence in your reply.
