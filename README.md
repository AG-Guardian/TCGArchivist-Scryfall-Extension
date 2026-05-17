# TCGArchivist Scryfall Collection Filter

A [Tampermonkey](https://www.tampermonkey.net/) userscript that filters [Scryfall](https://scryfall.com) search results to cards in your [TCGArchivist](https://github.com/zagreer/TCGArchivist) collection. Import a CSV export once, then toggle **My collection only** on any search to see only the cards you own.

Works on Scryfall search pages (`https://scryfall.com/search*`).

## Features

- **Full-result filtering** — Fetches the complete search via the Scryfall API, filters against your collection, and rebuilds pagination (60 cards per page, matching Scryfall).
- **Two filter modes** (follows Scryfall’s “Show” / `unique` setting):
  - **Cards** (default) — One tile per card name; shows your collection’s printing and a badge with owned printings.
  - **All prints** (`unique:prints`) — Shows every printing you own that matches the search, by Scryfall ID.
- **Persistent storage** — Collection and filter preference survive browser restarts (Tampermonkey `GM_setValue`).
- **Progress UI** — Import progress in the toolbar; search/filter progress centered under the search summary.

## Requirements

- A Chromium- or Firefox-based browser with [Tampermonkey](https://www.tampermonkey.net/) installed.
- A TCGArchivist **collection CSV export** with at least these columns:
  - `Name`
  - `Scryfall ID`
  - `Set code` and `Collector number` (used for printing labels and links)
  - `Finish` (optional; shown in badges)

## Chrome: Tampermonkey extension settings

If you use **Google Chrome** or other **Chromium** browsers, configure Tampermonkey once so userscripts can run (including on Scryfall) and optional local file access works.

1. Open Chrome’s extensions page:
   - Menu → **Extensions** → **Manage Extensions**, or
   - Enter `chrome://extensions/` in the address bar.
2. Find **Tampermonkey** and open **Details** (or click the extension name).
3. Turn on:
   - **Allow User Scripts** — required on recent Chrome versions for Tampermonkey to inject userscripts on websites like Scryfall.
   - **Allow access to file URLs** — allows the extension to run on `file://` pages (useful if you open saved HTML locally or test from a file); not required for normal use on [scryfall.com](https://scryfall.com).
4. Confirm Tampermonkey is **Enabled** on the same page.

You may need to reload any open Scryfall tabs after changing these settings.

> **Firefox / Edge:** These exact toggles are Chrome-specific. On Firefox, ensure Tampermonkey is allowed on Scryfall when prompted. On Edge, check **Manage extension** for similar permission options if scripts do not run.

## Installing

### Install from GitHub (recommended)

Tampermonkey can install and auto-update the script from the hosted `.user.js` file on GitHub ([details](https://stackoverflow.com/questions/72545851/how-to-make-userscript-auto-update-from-private-domain-github)).

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the **raw** install URL in a new tab:

   **https://github.com/AG-Guardian/TCGArchivist-Scryfall-Extension/raw/main/extension.user.js**

3. Tampermonkey should show an **Install** prompt. Confirm to add the script.
4. In Tampermonkey → **Dashboard**, confirm **TCGArchivist Scryfall Collection Filter** is **Enabled**.

If no prompt appears, click the Tampermonkey icon → **Create a new script** is not needed; instead use **Dashboard** → **Utilities** → paste the URL above into **Install from URL** (if your Tampermonkey version offers it), or use the manual option below.

### Install from a local copy (development)

1. Clone this repository.
2. Open Tampermonkey → **Dashboard** → **Utilities** → **Import from file** (or drag the file onto the dashboard).
3. Select [`extension.user.js`](extension.user.js).
4. Save and enable the script.

### After install

1. Go to [scryfall.com](https://scryfall.com) and run any search (e.g. `t:creature c:g`).
2. In the search controls row (next to **Show**, **as**, **sorted by**), you should see:
   - **collection** dropdown (`All results` / `My collection only`)
   - **Import CSV** button

If the controls do not appear, refresh the page or check that the script is enabled and matches `https://scryfall.com/search*`.

## Using the extension

### 1. Import your collection

1. Export your collection from TCGArchivist as CSV.
2. On a Scryfall search page, click **Import CSV**.
3. Select your export file.
4. Wait for the import progress bar to finish (large collections may take a few seconds).

The collection is saved in Tampermonkey storage. You only need to re-import when your collection changes or after clearing script storage.

### 2. Filter search results

1. Run a search on Scryfall (grid view recommended).
2. Set the **collection** dropdown to **My collection only**.
3. To see all Scryfall results again, set **collection** to **All results**.

**Note: the filtering only works when the display is set to "Images"**


### 3. Read the UI

| Element | Meaning |
|--------|---------|
| **collection → My collection only** | Filter active |
| Search summary suffix | e.g. `· Filtering 129 total results` (appended to Scryfall’s “where …” text) |
| Pagination | Reflects **filtered** totals, not the original Scryfall page count |
| Purple badge on a card | You own multiple printings; hover for the full list, or a single printing label if you only own one |

### Filter behavior by search type

| Scryfall “Show” / search | What you see when filtered |
|--------------------------|----------------------------|
| **Cards** (default) | One result per card **name** you own; image/links use your first listed printing in the CSV |
| **All prints** (`unique:prints` in query or Show menu) | Every **printing** you own that matches the search (matched by Scryfall ID) |

## Troubleshooting

| Problem | What to try |
|--------|-------------|
| Controls missing | Hard refresh; confirm script is enabled; URL must be `/search...`; on Chrome, enable **Allow User Scripts** for Tampermonkey (see above) |
| Dropdown disabled | Import a CSV first; wait if a search is still loading |
| “No collection loaded” in summary | Click **Import CSV** |
| “Could not load full search” | Check network; retry; Scryfall may be rate-limiting—wait and try again |
| Wrong or empty results after update | Re-import your CSV |
| Import hangs or fails | Very large CSVs need time; ensure **Name** and **Scryfall ID** columns exist |
| Storage full | Tampermonkey → script → Storage → delete old data, then re-import |
| Updates not offered | Install must use the [raw `.user.js` URL](https://github.com/AG-Guardian/TCGArchivist-Scryfall-Extension/raw/main/extension.user.js); bump `@version` on GitHub |

To reset everything: Tampermonkey → **TCGArchivist Scryfall Collection Filter** → **Storage** → delete everything, then re-import.

## Privacy

- Your collection is stored **locally** in Tampermonkey (`GM_setValue`), not sent to any third party except Scryfall’s public search API when filtering.