# Email Source Verifier

This Chrome Manifest V3 extension searches Google for an email address without quoting the query, opens eligible result pages, scrolls each page to load lazy content, and checks the rendered page/source for the email. It recognizes normal and obfuscated forms such as `name [at] email [dot] com`. Matching URLs are reported in the popup with a snippet and a button that reopens the page and highlights the match.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked** and select this folder.
4. Pin **Email Source Verifier** to the toolbar.

The extension uses `<all_urls>` because it must inspect the pages returned by Google. Use it only for addresses and websites you are authorized to research, and follow applicable site terms and rate limits.

## Behavior

- URLs from different hostnames can be scanned in parallel; URLs from the same hostname are queued one at a time.
- Google pagination is crawled until the configured per-run page limit, the threshold is reached, or Google has no next page.
- The Google tab stays open and receives a live progress panel. If a human-verification page is detected, that tab is focused and scanning waits for the challenge to be completed.
- Pressing **Search the web** again after a page-limit pause resumes from the next Google page.
- The match threshold ends the job and closes scan tabs.
- The excluded-domain toggle and list can be edited from the bottom of the popup.
- The on/off switch stops new work and can stop an active scan.
- Results are separated into full-email matches, optional partial local-part matches, and all other email addresses discovered on scanned pages.
- Enable **Partial match** to search for the part before `@` only when the full email is not present on a page.
- Optional Google Sheets export creates a versioned sheet such as `person@example.com - v1`, appends rows as pages are scanned, and reuses the current sheet when a run is resumed. To connect it, create a Google OAuth Web application client ID, register the redirect URL returned by the Chrome Identity API for this extension, then paste the client ID into the popup.


