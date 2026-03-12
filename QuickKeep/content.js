/**
 * QuickKeep — content.js
 * Injected into every page via manifest.json content_scripts.
 *
 * TWO TRIGGER MODES:
 * ─────────────────────────────────────────────────────────────
 *  1. DOUBLE-CLICK  → for saving a page quickly, or capturing a
 *                     single word the browser auto-selects on dblclick.
 *                     Opens the save overlay at the cursor position.
 *
 *  2. MOUSE SELECTION PILL → when the user drags to select longer
 *                     text (titles, sentences, paragraphs), a small
 *                     floating "Save" pill appears near the selection.
 *                     Clicking it opens the save overlay with the
 *                     selected text pre-filled as the note.
 *
 * This avoids the conflict where a drag-select ends in a dblclick
 * and the selection is lost before it can be captured.
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  // ── Constants ────────────────────────────────────────────────
  const STORAGE_KEY = "quickkeep_entries";
  const OVERLAY_ID = "qkt-overlay-root";
  const PILL_ID = "qkt-selection-pill";
  const HIDE_DELAY = 180; // ms — overlay fade-out
  const PILL_HIDE_DELAY = 200; // ms — pill fade-out
  // Minimum character count before the selection pill appears.
  // Single words (≤ this length) are handled by double-click instead.
  const PILL_MIN_CHARS = 8;

  // ── State ────────────────────────────────────────────────────
  let currentOverlay = null;
  let currentPill = null;
  let outsideClickHandler = null;
  let pillHideTimer = null;

  // ── Utility: Unique ID ────────────────────────────────────────
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ── Utility: Escape HTML to prevent XSS ──────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Utility: Strip URL to hostname ───────────────────────────
  function shortHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  // ── Utility: Clamp overlay within viewport ───────────────────
  function clampPosition(x, y, w, h) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;

    let left = x - 16;
    let top = y + 14;

    if (left + w + margin > vw) left = vw - w - margin;
    if (left < margin) left = margin;
    if (top + h + margin > vh) top = y - h - 10;
    if (top < margin) top = margin;

    return { top, left };
  }

  // ── Storage ───────────────────────────────────────────────────

  // Send save to background service worker, which bridges to the popup/Firebase
  function saveToBackground(url, title, note) {
    return new Promise((resolve, reject) => {
      // chrome.runtime can become undefined if the extension was reloaded
      // while this content script was still running on the page.
      // In that case fall back to local storage silently.
      if (!chrome?.runtime?.sendMessage) {
        saveToLocalFallback(url, title, note).then(resolve).catch(reject);
        return;
      }

      try {
        chrome.runtime.sendMessage(
          { type: "SAVE_PAGE", url, title, note },
          (response) => {
            if (chrome.runtime.lastError) {
              // Context invalidated mid-call — fall back to local
              saveToLocalFallback(url, title, note).then(resolve).catch(reject);
            } else {
              resolve(response);
            }
          },
        );
      } catch (err) {
        // Catch any synchronous throws from invalidated context
        saveToLocalFallback(url, title, note).then(resolve).catch(reject);
      }
    });
  }

  // Fallback: save directly to chrome.storage.local when background is unavailable
  function saveToLocalFallback(url, title, note) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["quickkeep_entries"], (r) => {
        const entries = r["quickkeep_entries"] || [];
        const existingIdx = entries.findIndex((e) => e.url === url);
        const genId = () =>
          Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        if (existingIdx > -1) {
          entries[existingIdx].note = note;
          entries[existingIdx].savedAt = Date.now();
        } else {
          entries.unshift({
            id: genId(),
            url,
            title,
            note,
            savedAt: Date.now(),
          });
        }

        chrome.storage.local.set({ quickkeep_entries: entries }, () =>
          resolve({ ok: true, local: true }),
        );
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  PILL — floating "Save" button that appears on text selection
  // ─────────────────────────────────────────────────────────────

  function removePill(immediate = false) {
    clearTimeout(pillHideTimer);
    if (!currentPill || !currentPill.isConnected) return;

    if (immediate) {
      currentPill.remove();
      currentPill = null;
      return;
    }

    currentPill.style.opacity = "0";
    currentPill.style.transform = "translateY(4px) scale(0.9)";
    pillHideTimer = setTimeout(() => {
      currentPill?.remove();
      currentPill = null;
    }, PILL_HIDE_DELAY);
  }

  function showSelectionPill(selectedText) {
    removePill(true);

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || rect.width === 0) return;

    const pill = document.createElement("div");
    pill.id = PILL_ID;
    pill.setAttribute("role", "button");
    pill.setAttribute("aria-label", "Save selection with QuickKeep");

    pill.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>
      Save to QuickKeep
    `;

    Object.assign(pill.style, {
      position: "fixed",
      zIndex: "2147483646",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "7px 13px",
      background: "linear-gradient(135deg, #6366f1, #4f46e5)",
      color: "#fff",
      fontSize: "12px",
      fontFamily: "'Geist', 'DM Sans', system-ui, sans-serif",
      fontWeight: "600",
      letterSpacing: "0.1px",
      borderRadius: "20px",
      boxShadow:
        "0 4px 20px rgba(99,102,241,0.45), 0 0 0 1px rgba(255,255,255,0.1)",
      cursor: "pointer",
      userSelect: "none",
      whiteSpace: "nowrap",
      opacity: "0",
      transform: "translateY(6px) scale(0.92)",
      transition:
        "opacity 0.18s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1)",
      pointerEvents: "all",
    });

    document.body.appendChild(pill);

    const pillW = pill.offsetWidth || 160;
    const pillH = pill.offsetHeight || 34;
    const vw = window.innerWidth;
    const margin = 10;

    let left = rect.left + rect.width / 2 - pillW / 2;
    if (left + pillW + margin > vw) left = vw - pillW - margin;
    if (left < margin) left = margin;

    let top = rect.top - pillH - 10;
    if (top < margin) top = rect.bottom + 10;

    pill.style.left = `${left}px`;
    pill.style.top = `${top}px`;

    currentPill = pill;

    requestAnimationFrame(() => {
      if (!pill.isConnected) return;
      pill.style.opacity = "1";
      pill.style.transform = "translateY(0) scale(1)";
    });

    pill.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const pillRect = pill.getBoundingClientRect();
      const fakeEvt = {
        clientX: pillRect.left + pillRect.width / 2,
        clientY: pillRect.top,
      };

      removePill(true);
      injectOverlay(fakeEvt, selectedText);
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  OVERLAY — the main save dialog
  // ─────────────────────────────────────────────────────────────

  function removeOverlay(overlay, immediate = false) {
    if (!overlay || !overlay.isConnected) return;

    if (outsideClickHandler) {
      document.removeEventListener("mousedown", outsideClickHandler, true);
      outsideClickHandler = null;
    }

    if (immediate) {
      overlay.remove();
      if (currentOverlay === overlay) currentOverlay = null;
      return;
    }

    overlay.classList.add("qkt-hiding");
    setTimeout(() => {
      overlay.remove();
      if (currentOverlay === overlay) currentOverlay = null;
    }, HIDE_DELAY);
  }

  function injectOverlay(position, selection) {
    if (currentOverlay) removeOverlay(currentOverlay, true);

    const title = document.title || "Untitled";
    const url = window.location.href;

    const overlay = document.createElement("div");
    overlay.className = "qkt-overlay";
    overlay.id = OVERLAY_ID;

    const previewText =
      selection.length > 65 ? selection.slice(0, 62) + "…" : selection;

    overlay.innerHTML = `
      <div class="qkt-header">
        <div class="qkt-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
               stroke="white" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="qkt-title-line">
          <div class="qkt-page-title">${escapeHtml(title.slice(0, 55))}</div>
          <div class="qkt-page-url">${escapeHtml(shortHost(url))}</div>
        </div>
        <button class="qkt-close" id="qkt-close-btn" aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      ${
        previewText
          ? `
        <div class="qkt-selection-preview" title="${escapeHtml(selection)}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.5">
            <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>
            <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>
          </svg>
          ${escapeHtml(previewText)}
        </div>
      `
          : ""
      }

      <textarea
        class="qkt-note"
        id="qkt-note-field"
        rows="2"
        placeholder="Add a note… (or leave blank)"
      >${escapeHtml(selection.slice(0, 300))}</textarea>

      <div class="qkt-hint">Ctrl+Enter to save · Esc to close</div>

      <div class="qkt-actions">
        <button class="qkt-btn qkt-btn-cancel" id="qkt-cancel-btn">Cancel</button>
        <button class="qkt-btn qkt-btn-save"   id="qkt-save-btn">Save Page</button>
      </div>
    `;

    overlay.style.visibility = "hidden";
    document.body.appendChild(overlay);
    const estH = overlay.offsetHeight || 210;
    const { top, left } = clampPosition(
      position.clientX,
      position.clientY,
      284,
      estH,
    );
    overlay.style.top = `${top}px`;
    overlay.style.left = `${left}px`;
    overlay.style.visibility = "visible";
    currentOverlay = overlay;

    const noteField = overlay.querySelector("#qkt-note-field");
    requestAnimationFrame(() => {
      noteField.focus();
      noteField.setSelectionRange(
        noteField.value.length,
        noteField.value.length,
      );
    });

    overlay
      .querySelector("#qkt-close-btn")
      .addEventListener("click", () => removeOverlay(overlay));
    overlay
      .querySelector("#qkt-cancel-btn")
      .addEventListener("click", () => removeOverlay(overlay));
    overlay.querySelector("#qkt-save-btn").addEventListener("click", () => {
      handleSave(overlay, url, title, noteField.value.trim());
    });

    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") removeOverlay(overlay);
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        handleSave(overlay, url, title, noteField.value.trim());
      }
    });

    outsideClickHandler = (e) => {
      if (!overlay.contains(e.target)) removeOverlay(overlay);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", outsideClickHandler, true);
    }, 280);
  }

  // ─────────────────────────────────────────────────────────────
  //  SAVE HANDLER
  // ─────────────────────────────────────────────────────────────

  async function handleSave(overlay, url, title, note) {
    const saveBtn = overlay.querySelector("#qkt-save-btn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
    }

    try {
      await saveToBackground(url, title, note);

      overlay.classList.add("qkt-saved");
      overlay.innerHTML = `
        <div class="qkt-success-flash">
          <div class="qkt-check-ring">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                 stroke="#a5b4fc" stroke-width="2.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <p>Page saved!</p>
          <span>${escapeHtml(shortHost(url))}</span>
        </div>
      `;

      setTimeout(() => removeOverlay(overlay), 1500);
    } catch (err) {
      console.error("[QuickKeep] Save error:", err);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Retry";
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  TRIGGER 1 — Double-click
  // ─────────────────────────────────────────────────────────────
  document.addEventListener("dblclick", (evt) => {
    if (
      evt.target.closest(`#${OVERLAY_ID}`) ||
      evt.target.closest(`#${PILL_ID}`)
    )
      return;

    if (currentPill) return;

    const selection = window.getSelection()?.toString().trim() || "";
    injectOverlay(evt, selection);
  });

  // ─────────────────────────────────────────────────────────────
  //  TRIGGER 2 — Mouse selection pill
  // ─────────────────────────────────────────────────────────────
  document.addEventListener("mouseup", (evt) => {
    if (
      evt.target.closest(`#${OVERLAY_ID}`) ||
      evt.target.closest(`#${PILL_ID}`)
    )
      return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() || "";

      if (text.length >= PILL_MIN_CHARS) {
        showSelectionPill(text);
      } else {
        removePill();
      }
    }, 10);
  });

  // ── Hide pill when user starts a new selection or clicks away ──
  document.addEventListener("mousedown", (evt) => {
    if (evt.target.closest(`#${PILL_ID}`)) return;
    removePill();
  });

  // ── Hide pill on scroll ──
  window.addEventListener("scroll", () => removePill(), { passive: true });
})(); // end IIFE
