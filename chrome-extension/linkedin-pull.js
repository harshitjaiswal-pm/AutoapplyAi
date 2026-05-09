/**
 * LINKEDIN AUTO-PULL — Content script triggered from /console.
 *
 * Flow:
 *   1. User on /console clicks "Pull from LinkedIn", fills filter form.
 *   2. /console postMessages the trigger config to pipeline-bridge.js (a
 *      content script that runs on the same page). pipeline-bridge.js
 *      writes chrome.storage.local._aa_pull_linkedin = {keywords, location,
 *      remote, count, consoleUrl}. Page-side JS can't write chrome.storage
 *      directly because content scripts run in an isolated world.
 *   3. /console opens linkedin.com/jobs/search?... in a new tab.
 *   4. THIS SCRIPT runs on the search page, reads the storage trigger,
 *      scrapes visible job cards, filters out Easy Apply, resolves each
 *      survivor's external ATS apply URL via fetch(), stuffs results into
 *      chrome.storage.local.pendingJobs, and navigates back to /console.
 *   5. /console runs pipeline-bridge.js which POSTs each pending job to
 *      /api/console/jobs. That endpoint validates, dedupes, and enforces
 *      the 100/day cap.
 *
 * Why a separate file (not bolted onto content.js): content.js has a 3000+
 * line floating-panel + Easy Apply autofill flow. This is a small auto
 * scraper that only fires when the trigger flag is set.
 */

(() => {
  // Only fire on LinkedIn job search pages — both the classic /jobs/search
  // and the AI-powered /jobs/search-results URLs.
  if (!/^\/jobs\/search/.test(location.pathname)) return;

  // Race tolerance: the page postMessages the config, the bridge writes
  // it to chrome.storage, then the new tab opens. Storage write is fast
  // but not instant; if the LinkedIn page loads before the storage
  // write completes, we'd bail. So we poll a few times before giving up.
  pollForTrigger(0);

  // Hard cap on pagination depth. 25 jobs/page × 4 pages = 100 max, which
  // matches the per-day capture cap and keeps runtime bounded if every
  // page is mostly Easy Apply.
  const MAX_PAGES = 4;
  // Target jobs per pull. cfg.count overrides at trigger time.
  const DEFAULT_TARGET = 25;

  function pollForTrigger(attempt) {
    chrome.storage.local.get(["_aa_pull_linkedin", "_aa_pull_linkedin_progress"], (data) => {
      // Continuation: a previous page kicked us into this one to keep
      // collecting jobs. The progress object carries cfg + accumulated
      // jobs + page index, so we can pick up where we left off.
      if (data._aa_pull_linkedin_progress) {
        const prog = data._aa_pull_linkedin_progress;
        chrome.storage.local.remove(["_aa_pull_linkedin_progress"], () => {
          setTimeout(() => start(prog.cfg, prog.accumulated || [], prog.page || 1), 2000);
        });
        return;
      }
      // Fresh trigger: first page of a new pull.
      const cfg = data._aa_pull_linkedin;
      if (cfg) {
        chrome.storage.local.remove(["_aa_pull_linkedin"], () => {
          setTimeout(() => start(cfg, [], 0), 2000);
        });
        return;
      }
      // Neither flag is present yet. Bridge write may still be in flight;
      // poll up to ~3s before giving up so a normal LinkedIn search session
      // is unaffected.
      if (attempt >= 4) return;
      setTimeout(() => pollForTrigger(attempt + 1), 600);
    });
  }

  function start(cfg, accumulated, page) {
    console.log(`[AutoApply LinkedIn pull] page ${page + 1}/${MAX_PAGES} — accumulated=${accumulated.length} target=${cfg.count || DEFAULT_TARGET}`);
    showOverlay(`Page ${page + 1}: scanning LinkedIn for jobs…`);

    autoScroll().then(scrapeAndForward).catch((e) => {
      console.error("[AutoApply LinkedIn pull] scrape failed:", e);
      showOverlay(`Scrape failed: ${e.message || e}`, "error");
    });

    async function scrapeAndForward() {
      const target = cfg.count || DEFAULT_TARGET;
      const jobs = scrapeCards();
      if (!jobs.length && accumulated.length === 0) {
        showOverlay("No jobs found on this page. Try a different filter.", "error");
        return;
      }
      const remaining = target - accumulated.length;
      // Easy Apply is filtered out — worker can't drive LinkedIn's internal
      // modal. Slice to remaining so we don't over-resolve URLs we'll throw away.
      const external = jobs.filter((j) => !j.easyApply).slice(0, remaining);
      const skippedEasyApply = jobs.length - jobs.filter((j) => !j.easyApply).length;

      // Try to resolve each job's external ATS URL. Modern LinkedIn doesn't
      // ship the apply URL in the SSR HTML for /jobs/view/<id> — it's
      // fetched lazily via voyager API at click-time. So our fetch-and-grep
      // succeeds rarely. When it fails, FALL BACK to the LinkedIn URL
      // itself: the user can still click into the captured row from /console,
      // LinkedIn redirects to the ATS, and the existing extension takes over.
      // Better than dropping the job entirely.
      showOverlay(`Resolving apply URLs for ${external.length} jobs…`);
      const resolved = [];
      let resolvedCount = 0;
      for (let i = 0; i < external.length; i++) {
        const j = external[i];
        showOverlay(`Resolving ${i + 1}/${external.length}: ${j.title}`);
        const meta = await resolveJobMeta(j.linkedinJobId);

        // Use scraped values where available; fall back to fetched HTML
        // values when the card scrape produced placeholders or empty.
        const isPlaceholder = j._parseFailed || /^LinkedIn job /.test(j.title) || j.title === "—";
        const isUnparsedCompany = j.company === "(unparsed)" || !j.company;
        const finalTitle = (isPlaceholder && meta.title) ? meta.title : j.title;
        const finalCompany = (isUnparsedCompany && meta.company) ? meta.company : j.company;

        if (meta.applyUrl) {
          resolvedCount++;
          resolved.push({
            jobUrl: meta.applyUrl,
            title: finalTitle,
            company: finalCompany,
            location: j.location,
            source: "extension",
          });
        } else if (j.linkedinJobId) {
          // Fall back to the LinkedIn URL — capture is still useful as a
          // staging row even if we can't auto-apply.
          resolved.push({
            jobUrl: `https://www.linkedin.com/jobs/view/${j.linkedinJobId}/`,
            title: finalTitle,
            company: finalCompany,
            location: j.location,
            source: "extension",
          });
        }
        // Tiny stagger so we don't hammer LinkedIn with 25 fetches in
        // ~one event-loop tick. 200ms keeps the user's request rate
        // indistinguishable from a person clicking through results.
        await new Promise((r) => setTimeout(r, 200));
      }

      // Merge this page's resolved jobs into the running accumulator,
      // deduping by jobUrl so a re-paginate doesn't double-up.
      const seenUrls = new Set(accumulated.map((j) => j.jobUrl));
      for (const r of resolved) {
        if (!seenUrls.has(r.jobUrl)) {
          accumulated.push(r);
          seenUrls.add(r.jobUrl);
        }
      }

      // Decide: keep going or wrap up?
      const haveEnough = accumulated.length >= target;
      const nextPage = page + 1;
      const exhaustedPages = nextPage >= MAX_PAGES;

      if (!haveEnough && !exhaustedPages) {
        // Persist progress and navigate to the next LinkedIn results page.
        // LinkedIn pagination is `&start=N` (0-indexed, 25 per page).
        showOverlay(`Page ${page + 1}: ${accumulated.length}/${target} so far. Loading next page…`);
        chrome.storage.local.set(
          { _aa_pull_linkedin_progress: { cfg, accumulated, page: nextPage } },
          () => {
            const url = new URL(location.href);
            url.searchParams.set("start", String(nextPage * 25));
            // Pause briefly so the user reads the overlay, then navigate.
            // location.assign forces a real navigation (vs. SPA route),
            // ensuring linkedin-pull.js re-runs on the next page.
            setTimeout(() => {
              location.assign(url.toString());
            }, 1200);
          }
        );
        return;
      }

      // Done — finalize and hand off to /console.
      if (accumulated.length === 0) {
        showOverlay(`No jobs to capture — ${skippedEasyApply} Easy Apply skipped.`, "error");
        return;
      }

      chrome.storage.local.set({ pendingJobs: accumulated }, () => {
        const parts = [`Captured ${accumulated.length} jobs`];
        if (exhaustedPages && accumulated.length < target) {
          parts.push(`stopped after ${MAX_PAGES} pages`);
        }
        showOverlay(`${parts.join(", ")}. Returning to Console…`, "ok");
        // Hand off to the Console — pipeline-bridge.js will POST each
        // pending job to /api/console/jobs as the page loads.
        setTimeout(() => {
          location.href = cfg.consoleUrl || "/";
        }, 1500);
      });
    }
  }


  /** Fetch the LinkedIn JD page (uses the user's session cookies), parse
   *  the HTML, and extract { applyUrl, title, company }. We get all three
   *  from the same fetch so we can both find the external apply URL AND
   *  recover title/company when card-level DOM scraping failed (placeholder
   *  rows). Returns { applyUrl: null, title: null, company: null } if the
   *  fetch itself fails — caller treats fields as missing.
   *
   *  Title extraction: <title>Job Title - Company - LinkedIn</title> is
   *  always present; we split on " - " and take the first segment.
   *  Company extraction: same split, second segment. Both gracefully
   *  fall back to null if the format isn't as expected. */
  async function resolveJobMeta(linkedinJobId) {
    const empty = { applyUrl: null, title: null, company: null };
    if (!linkedinJobId) return empty;
    try {
      const res = await fetch(`https://www.linkedin.com/jobs/view/${linkedinJobId}/`, {
        credentials: "include",
        headers: { Accept: "text/html" },
      });
      if (!res.ok) {
        console.warn(`[AutoApply LinkedIn pull] fetch /jobs/view/${linkedinJobId} → ${res.status}`);
        return empty;
      }
      const html = await res.text();
      return {
        applyUrl: extractApplyUrl(html),
        title: extractTitleFromHtml(html),
        company: extractCompanyFromHtml(html),
      };
    } catch (e) {
      console.warn(`[AutoApply LinkedIn pull] resolveJobMeta failed for ${linkedinJobId}:`, e);
      return empty;
    }
  }

  /** Three extraction patterns for the apply URL, ordered most-specific →
   *  least. Returns null if none yields a usable URL. */
  function extractApplyUrl(html) {
    // Pattern 1: <code id="applyUrl">"https://..."</code>
    const codeMatch = html.match(/<code[^>]*id=["']applyUrl["'][^>]*>\s*"([^"]+)"\s*<\/code>/);
    if (codeMatch) return decodeHtmlEntities(codeMatch[1]);

    // Pattern 2: anchor with data-tracking-control-name
    const anchorMatch = html.match(
      /<a[^>]*data-tracking-control-name=["']public_jobs_apply-link-(?:onsite|offsite)["'][^>]*\shref=["']([^"']+)["']/
    );
    if (anchorMatch) return decodeHtmlEntities(anchorMatch[1]);

    // Pattern 3: any href on a known ATS host (last-resort).
    const ats = html.match(
      /href=["'](https?:\/\/[^"']*(?:myworkdayjobs\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|icims\.com|successfactors\.com|brainhunter\.com|taleo\.net)[^"']*)["']/
    );
    if (ats) return decodeHtmlEntities(ats[1]);

    return null;
  }

  /** Extract job title from the HTML <title> tag. LinkedIn formats it
   *  as "Job Title - Company - LinkedIn" or "Job Title hiring … | LinkedIn".
   *  Returns null on no match. */
  function extractTitleFromHtml(html) {
    const m = html.match(/<title>([^<]+)<\/title>/);
    if (!m) return null;
    let t = decodeHtmlEntities(m[1]).trim();
    // Strip the trailing " - LinkedIn" or " | LinkedIn"
    t = t.replace(/\s*[-|]\s*LinkedIn\s*$/i, "").trim();
    // If the title is "Job Title - Company", split on " - " and take first.
    // If it's "Company hiring Job Title in Location", take after "hiring".
    const hiringMatch = t.match(/.+\s+hiring\s+(.+?)\s+in\s+/i);
    if (hiringMatch) return hiringMatch[1].trim();
    const dashIdx = t.lastIndexOf(" - ");
    if (dashIdx > 0) return t.substring(0, dashIdx).trim();
    return t || null;
  }

  /** Extract company name. LinkedIn embeds it in og:site_name occasionally
   *  but more reliably in the <title> as "Job Title - Company - LinkedIn"
   *  or "Company hiring Job Title in Location". */
  function extractCompanyFromHtml(html) {
    const m = html.match(/<title>([^<]+)<\/title>/);
    if (!m) return null;
    let t = decodeHtmlEntities(m[1]).trim();
    t = t.replace(/\s*[-|]\s*LinkedIn\s*$/i, "").trim();
    const hiringMatch = t.match(/^(.+?)\s+hiring\s+/i);
    if (hiringMatch) return hiringMatch[1].trim();
    const dashIdx = t.lastIndexOf(" - ");
    if (dashIdx > 0) return t.substring(dashIdx + 3).trim();
    return null;
  }

  function decodeHtmlEntities(s) {
    return s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/g, "/")
      .replace(/&#39;/g, "'");
  }

  /** Scrape visible job cards. Mirrors the proven scrapeStrategyA +
   *  parseCardText logic from content.js — that scraper has been
   *  field-tested over months and handles edge cases like the
   *  "with verification" suffix, noise lines (Promoted, Easy Apply,
   *  "X days ago"), and emoji prefixes on locations. We duplicate it
   *  here rather than sharing the file so this script stays self
   *  contained and the LinkedIn search-page entrypoint isn't coupled
   *  to content.js's IIFE state. */
  function scrapeCards() {
    const cards = document.querySelectorAll("li[data-occludable-job-id]");
    console.log(`[AutoApply LinkedIn pull] found ${cards.length} cards in DOM`);
    const out = [];
    let failures = 0;
    cards.forEach((card, idx) => {
      try {
        const jobId = card.getAttribute("data-occludable-job-id") || "";
        const titleLink =
          card.querySelector("a.job-card-container__link") ||
          card.querySelector('a[href*="/jobs/view/"]') ||
          card.querySelector("a");
        let title = "";
        if (titleLink) {
          // <strong> > class*=title > aria-label > textContent
          // aria-label last because LinkedIn appends " with verification"
          title =
            titleLink.querySelector("strong")?.textContent?.trim() ||
            titleLink.querySelector('[class*="title"]')?.textContent?.trim() ||
            titleLink.getAttribute("aria-label") ||
            titleLink.textContent?.trim() ||
            "";
        }
        title = title.replace(/\s+with verification$/i, "").replace(/\s*\(Verified job\)/gi, "").trim();
        if (!title || title.length < 3) {
          // Last resort: scroll the card into view and re-read after a
          // beat. Some cards are still hydrating when we hit them.
          card.scrollIntoView({ block: "center", behavior: "auto" });
          // sync re-read — can't await inside forEach but the scroll
          // alone often wakes hydration enough for a second look.
          const retryLink =
            card.querySelector("a.job-card-container__link") ||
            card.querySelector('a[href*="/jobs/view/"]');
          if (retryLink) {
            title = (retryLink.querySelector("strong")?.textContent?.trim() ||
                     retryLink.getAttribute("aria-label") ||
                     retryLink.textContent?.trim() || "")
              .replace(/\s+with verification$/i, "")
              .replace(/\s*\(Verified job\)/gi, "")
              .trim();
          }
          if (!title || title.length < 3) {
            // Guardrail: rather than silently drop the card, capture it as
            // a placeholder with the LinkedIn URL so nothing slips through.
            // User can audit unparseable rows on /console — safer than
            // dropping a non-Easy-Apply listing because of a scraping
            // edge case. We mark it Easy Apply only if we can detect that
            // — otherwise treat as external (the safer assumption).
            if (jobId) {
              const isEasyApply = /easy apply/i.test(card.innerText || "");
              out.push({
                linkedinJobId: jobId,
                title: `LinkedIn job ${jobId}`,
                company: "(unparsed)",
                location: "",
                easyApply: isEasyApply,
                _parseFailed: true,
              });
              console.log(`[AutoApply LinkedIn pull] card ${idx}: kept as fallback — title parse failed (jobId=${jobId})`);
            } else {
              failures++;
              console.log(`[AutoApply LinkedIn pull] card ${idx}: dropped — no title and no jobId`);
            }
            return;
          }
        }

        // Use card.innerText if it has content; otherwise pull title/company
        // from direct DOM nodes. Some virtualized cards have partial render
        // (links present but innerText empty).
        let cardText = card.innerText || "";
        if (cardText.trim().length < 20) {
          // Build a minimal text blob from the visible spans inside the card.
          const spans = card.querySelectorAll("span");
          const parts = [];
          spans.forEach((s) => {
            const t = (s.textContent || "").trim();
            if (t && t.length < 100 && parts.indexOf(t) === -1) parts.push(t);
          });
          cardText = parts.join("\n");
        }

        const { company, location: locationStr, easyApply } = parseCardText(cardText, title);
        out.push({ linkedinJobId: jobId, title, company, location: locationStr, easyApply });
      } catch (e) {
        failures++;
        console.warn(`[AutoApply LinkedIn pull] card ${idx} parse failed:`, e);
      }
    });
    console.log(`[AutoApply LinkedIn pull] scraped ${out.length} of ${cards.length} cards (${failures} failed)`);
    return out;
  }

  /** Mirrors content.js's parseCardText — robust company/location/easyApply
   *  extraction from the card's innerText. Skips noise lines, handles
   *  "with verification" suffix, normalizes location emoji prefixes. */
  function parseCardText(text, title) {
    text = (text || "").trim();
    if (!text || text.length < 10) return { company: "", location: "", easyApply: false };

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const titleLower = title.toLowerCase();
    const noiseWords = [
      "easy apply", "promoted", "verified", "actively recruiting",
      "actively reviewing", "viewed", "applied", "new", "dismiss",
      "be an early applicant", "people also viewed",
    ];

    let company = "";
    let location = "";
    let foundTitle = false;
    let companySet = false;

    for (const line of lines) {
      const lineLower = line.toLowerCase().replace(/\(verified job\)/i, "").trim();
      // Strip the "with verification" suffix LinkedIn appends to some
      // title renderings before comparing — so the second occurrence
      // ("Title with verification") still matches and gets skipped, not
      // grabbed as the company. Same for any line whose stripped form
      // equals or wraps the title.
      const lineLowerStripped = lineLower.replace(/\s+with verification$/i, "").trim();
      const isTitleLine =
        lineLower === titleLower ||
        lineLowerStripped === titleLower ||
        lineLower.includes(titleLower) ||
        titleLower.includes(lineLower);

      if (!foundTitle && isTitleLine) {
        foundTitle = true;
        continue;
      }
      if (foundTitle && isTitleLine) continue;
      if (noiseWords.some((n) => lineLower === n || lineLower.startsWith(n))) continue;
      if (line.length < 2) continue;
      if (/^\d+\s+(day|hour|minute|week|month)s?\s+ago$/i.test(line)) continue;
      if (/^just now$/i.test(line)) continue;

      if (!companySet) {
        company = line.replace(/\s*\(Verified job\)/i, "").trim();
        companySet = true;
        continue;
      }
      if (!location) {
        const cleanLoc = line.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}️‍]+\s*/u, "").trim();
        if (cleanLoc.toLowerCase() === company.toLowerCase()) continue;
        location = cleanLoc;
        break;
      }
    }

    if (!company && lines.length >= 2) company = lines[1]?.replace(/\s*\(Verified job\)/i, "") || "";
    if (!location && lines.length >= 3) location = lines[2] || "";
    const easyApply = text.toLowerCase().includes("easy apply");

    return { company, location, easyApply };
  }

  /** Scroll each LinkedIn job card directly into viewport so its content
   *  hydrates. LinkedIn uses occlusion-based virtualization — the <li>
   *  exists but its title/company/location only render when the card
   *  enters the viewport. Naive bottom-scroll only renders the cards
   *  near our scroll-stop positions; cards in between stay empty.
   *
   *  This iterates over every card[data-occludable-job-id], scrolls it
   *  into view, waits for its innerText to fill (or 800ms max), then
   *  moves on. By the time we return, every card the scrape will see
   *  has its content rendered. ~5-8 seconds for 25 cards. */
  async function autoScroll() {
    const list = document.querySelector(".jobs-search-results-list, .scaffold-layout__list");
    if (!list) return;
    const cards = document.querySelectorAll("li[data-occludable-job-id]");
    for (const card of cards) {
      card.scrollIntoView({ block: "center", behavior: "auto" });
      // Wait until the card's text is non-empty, capped at 800ms. Most
      // cards render within ~150ms after entering viewport.
      const start = Date.now();
      while (Date.now() - start < 800) {
        if ((card.innerText || "").trim().length > 30) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Scroll back to the top so the first card is in view, settle for
    // any final renders.
    list.scrollTo({ top: 0, behavior: "auto" });
    await new Promise((r) => setTimeout(r, 600));
  }

  /** Top-banner status overlay so the user sees what's happening on
   *  the LinkedIn tab before it auto-redirects. Three states: info /
   *  ok / error. Disappears with the redirect. */
  function showOverlay(message, level = "info") {
    let el = document.getElementById("aa-linkedin-pull-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "aa-linkedin-pull-overlay";
      el.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
        padding: 14px 24px; font: 600 14px -apple-system,system-ui,sans-serif;
        text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      `;
      document.body.appendChild(el);
    }
    const colors = {
      info: ["#1f2937", "#ffffff"],
      ok: ["#065f46", "#d1fae5"],
      error: ["#991b1b", "#fee2e2"],
    };
    const [bg, fg] = colors[level] || colors.info;
    el.style.background = bg;
    el.style.color = fg;
    el.textContent = `AutoApply: ${message}`;
  }
})();
