# AutoApply — Credential Vault

Encrypted credential storage for password-gated ATS sites (BrainHunter/PHSA, Workday, Taleo, iCIMS, SuccessFactors, etc.). Lets AutoApply's content scripts auto-fill login forms on your behalf without Claude or anything else ever typing a plaintext password through the Cowork computer-use tier.

## Why this exists

Public-sector Canadian employers (PHSA, Fraser Health, VCH) sit behind a BrainHunter login gate that demands you log in before the real application form loads. Claude — whether via the Cowork computer-use tools or Claude-in-Chrome — is never allowed to type passwords, so every one of those applications stalled at the login step. The vault moves password entry *inside* the extension: the user stores the password once, encrypted under a master passphrase they control, and the ATS content script pulls it from chrome.storage.local and fills the form itself.

## Security model

- **Plaintext passwords never touch disk.** Only AES-GCM ciphertext is written to `chrome.storage.local`.
- **Key derivation:** master passphrase → PBKDF2 (SHA-256, 310000 iterations, random 16-byte salt) → 256-bit AES-GCM key.
- **In-memory key only.** The derived key lives in the background service worker's JS closure. When the MV3 service worker dies (~30s idle) or the user locks the vault, the key reference is dropped — nothing on disk is recoverable without the passphrase.
- **Auto-lock:** after 15 minutes of no vault API activity the key is zeroed.
- **Probe verification:** a fixed-string ("AA_VAULT_OK_v1") is encrypted once at init time and decrypted on unlock to verify the passphrase without trial-decrypting real entries.
- **Per-entry auto-submit is opt-in.** By default, the vault fills the username/password fields and waits for the user to press Enter or click Submit. Auto-click is available per entry if you trust the flow.
- **No plaintext logging.** `console.log` calls only emit hosts and success markers, never passwords.
- **Forget-passphrase = wipe.** There is no backdoor. The "wipe vault" button destroys `_vault_meta`, `_vault_probe`, and `_vault_entries` so you can start over.

## Storage shape

```
chrome.storage.local:
  _vault_meta: {
    version: 1,
    kdfSalt: base64(16 bytes),
    kdfIterations: 310000,
    createdAt: ISO,
  }
  _vault_probe: {
    iv: base64(12),
    ciphertext: base64,           // AES-GCM("AA_VAULT_OK_v1")
  }
  _vault_entries: {
    "brainhunter.com": {
      username: "kiran...@gmail.com",
      iv: base64(12),
      ciphertext: base64,          // AES-GCM(password)
      autoSubmit: false,
      notes: "",
      updatedAt: ISO,
    },
    ...
  }
```

## Runtime API

All vault operations go through `chrome.runtime.sendMessage` so content scripts and popup code share one path. The background service worker imports `ats/credential-vault.js` at startup and exposes:

| Message | Payload | Returns |
| --- | --- | --- |
| `VAULT_STATUS` | — | `{ exists, unlocked, version, autoLockMs }` |
| `VAULT_INIT` | `{ passphrase }` | `{ ok, created }` |
| `VAULT_UNLOCK` | `{ passphrase }` | `{ ok, error? }` |
| `VAULT_LOCK` | — | `{ ok }` |
| `VAULT_SET` | `{ host, username, password, autoSubmit?, notes? }` | `{ ok }` |
| `VAULT_GET` | `{ host }` | `{ ok, host, username, password, autoSubmit }` |
| `VAULT_LIST` | — | `{ ok, entries: [...] }` (no passwords) |
| `VAULT_DELETE` | `{ host }` | `{ ok }` |
| `VAULT_DESTROY` | — | `{ ok }` |

`VAULT_GET` does a hostname suffix fallback — e.g. if the stored host is `phsa.ca` and you land on `jobs.phsa.ca`, the entry is still matched. This lets one entry cover a portal plus its subdomains.

## Using the vault from an ATS script

```js
const resp = await new Promise((resolve) =>
  chrome.runtime.sendMessage(
    { type: "VAULT_GET", host: window.location.hostname },
    resolve
  )
);

if (!resp?.ok) {
  if (resp?.locked) postMessage({ type: "AA_LOGIN_REQUIRED", reason: "vault-locked" });
  else if (resp?.notFound) postMessage({ type: "AA_LOGIN_REQUIRED", reason: "entry-missing" });
  return;
}

document.querySelector('input[type="password"]').value = resp.password;
resp.password = null; // drop local reference ASAP
```

See `ats/brainhunter.js → handleLoginGate()` for the production pattern (with field discovery, opt-in auto-submit, and postMessage signaling).

## User flow

1. Open the AutoApply popup → **Vault 🔒** tab.
2. **First time:** enter a master passphrase (8+ chars), confirm, click "Create vault". The passphrase is never stored — the salt and an encrypted probe are, so unlock can verify it without holding it.
3. **Add an entry:** host (e.g. `brainhunter.com`), username, password, optional auto-submit. Click "Save entry".
4. **Returning:** the vault auto-locks after 15 min. Enter passphrase → Unlock.
5. **Forgot passphrase:** click the red "wipe vault" button. This destroys all entries. There is no recovery path.

## Threat model — what this does and doesn't protect against

**Protects against:**
- Plaintext passwords on disk — never.
- Another extension reading your `chrome.storage.local` as plaintext — only ciphertext.
- Claude/Cowork computer-use tier accidentally typing your password into something — the password never leaves the extension's background worker.
- Forgotten passphrase leaking entries — unrecoverable by design.

**Does NOT protect against:**
- A local attacker with your master passphrase.
- A malicious extension with chrome.debugger or scripting permissions that injects into background.js — any extension with high enough privilege on your profile can compromise any other.
- Keyloggers on the underlying OS.
- You pasting a password into a non-AutoApply tab.

This is a convenience layer that raises the bar from "nothing" to "encrypted at rest with per-user key," not a replacement for a password manager.

## Roadmap notes

- Wire identical login-gate handlers into `workday.js`, `successfactors.js`, `generic.js`, and any other ATS script that hits a password wall.
- Consider syncing `_vault_entries` through Supabase once the backend stabilizes — the ciphertext is safe to sync since the key never leaves the device. Meta/salt should sync too so the same passphrase unlocks the vault on multiple machines.
- Add a 1Password / Bitwarden import path later if users want to bring existing credentials.
