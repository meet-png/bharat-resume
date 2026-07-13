# Meta Business Verification — Step-by-Step Guide

**Purpose:** get the "Bharat Resume bot" Meta app out of Development / Unpublished mode so we can broadcast to the 100-student pilot without the 5-recipient cap.

**Timeline reality:** Meta's human review takes **2 – 5 business days**. Every hour of delay in submission pushes the pilot back a day. Once you finish the steps below, only wait — do not resubmit while it's under review or the clock resets.

**What we have working for us:**
- Live production website with `/privacy`, `/terms`, `/data-deletion` pages (created 2026-07-13).
- Live app at `https://bharat-resume-production.up.railway.app`.
- Existing Meta App (`4061685003963331`, "Bharat Resume bot") with WhatsApp Cloud API wired.
- Working end-to-end conversation and PDF delivery, already tested with real users on the 5-recipient allowlist.

---

## Phase 0 — Before you open Meta (30 minutes)

### 0.1 Documents to have on your desk

Have these open as PDFs or clear photos, ideally under 5 MB each, before starting. Meta rejects blurry or partial scans on sight.

| # | Document | Notes |
|---|---|---|
| 1 | **PAN Card** | Yours (as sole proprietor, personal PAN = business PAN). Front only. |
| 2 | **Aadhaar Card** | Front + back, or use masked-Aadhaar if you prefer (both sides). |
| 3 | **Bank Statement (last 3 months) or Cancelled Cheque** | Must show your legal name + account number. |
| 4 | **Utility bill (electricity / gas / phone landline) OR rental agreement** | Address proof in your name, within last 3 months. |
| 5 | **Udyam Registration Certificate** *(optional but strongly recommended)* | If you have MSME/Udyam registration for "Bharat Resume", upload it — it's the single strongest single-document proof of a legitimate small business. If you don't, register at [udyamregistration.gov.in](https://udyamregistration.gov.in) — free, takes 15 minutes, comes through same day. |
| 6 | **GST Certificate** *(only if registered)* | Below the ₹40 lakh threshold there's no mandate. Skip if you don't have one. |

### 0.2 Values that must match across every form

Write these down and paste them verbatim in every field Meta asks for. Any mismatch (extra space, differently capitalised word) creates review flags.

| Field | Exact value to use |
|---|---|
| **Legal business name** | *(exactly as on your PAN)*, e.g. `Meet Kabra` |
| **Doing-business-as name / brand name** | `Bharat Resume` |
| **Registered address** | *(exactly as on your Aadhaar / utility bill)* — full postal address including PIN code, no abbreviations |
| **Business phone** | *(your active mobile — the one that gets Meta's OTP)* |
| **Business email** | `help.bharatresume@gmail.com` |
| **Business website** | `https://bharat-resume-production.up.railway.app` |
| **Business category** | `Internet Software` (this maps cleanest to what we do) |
| **Business type** | `Sole Proprietorship` |
| **Country** | `India` |

### 0.3 App icon (need this before Phase 2)

Meta requires a 1024 × 1024 PNG app icon. You don't have a locked logo yet — here's a clean placeholder design that will pass review without looking amateur:

**Design spec** — do this in Canva (free) or Figma in 5 minutes:
- **Canvas:** 1024 × 1024 pixels, background solid `#1A3A5C` (navy — matches your resume PDF accent colour).
- **Text:** `BR` (uppercase), centred, font Georgia Bold, colour `#FFFFFF`, size 520 pt.
- **No border, no gradient, no drop shadow.**
- Export as PNG. Save as `app-icon-1024.png`.

*(If you have a designer / can make something better, use that. But this passes review and matches the brand consistently with the resume PDF.)*

---

## Phase 1 — Confirm live URLs before Meta touches them (10 minutes)

**Before opening Meta**, verify the three new pages are actually live on Railway. Meta's crawler fetches them; if they 404, verification fails immediately.

After Meet pushes the code (Phase 4 of my instructions to Claude), open each of these in your browser:

- ✅ `https://bharat-resume-production.up.railway.app/privacy` → should render the Privacy Policy
- ✅ `https://bharat-resume-production.up.railway.app/terms` → should render the Terms of Service
- ✅ `https://bharat-resume-production.up.railway.app/data-deletion` → should render the Data Deletion Instructions

All three must load in under 2 seconds and show clean, styled pages. **Do not proceed to Phase 2 until all three are green.**

---

## Phase 2 — Meta App Dashboard: Basic Settings (15 minutes)

Go to **[developers.facebook.com/apps](https://developers.facebook.com/apps)** → your `Bharat Resume bot` app (App ID `4061685003963331`) → **Settings → Basic** in the left sidebar.

Fill in **exactly** the following values:

### 2.1 Basic settings — top section

| Field | Value |
|---|---|
| **App Display Name** | `Bharat Resume` |
| **App Contact Email** | `help.bharatresume@gmail.com` |
| **Privacy Policy URL** | `https://bharat-resume-production.up.railway.app/privacy` |
| **User Data Deletion** | Choose **"Data Deletion Instructions URL"** → paste `https://bharat-resume-production.up.railway.app/data-deletion` |
| **Terms of Service URL** | `https://bharat-resume-production.up.railway.app/terms` |
| **App Icon** | Upload `app-icon-1024.png` from Phase 0.3 |
| **Category** | Select `Business` from the primary dropdown, then `Small Business` from the sub-category |
| **App Domains** | `bharat-resume-production.up.railway.app` *(no `https://`, no trailing slash)* |

### 2.2 Business Use Case description

Some versions of the Meta dashboard also ask for a short business-use description in Basic Settings. Paste this **verbatim**:

> Bharat Resume is a WhatsApp-based AI resume builder for Indian college students. Students converse with our automated agent ("Saathi") in English or Hinglish through the WhatsApp Business Cloud API. Our AI extracts their educational, technical, and project information, tailors it to a target job description, and delivers a professionally formatted PDF resume. A free watermarked preview is delivered without payment; a clean, ATS-readable version is unlocked via a ₹49 UPI payment through Razorpay. All personal data handling is described in our Privacy Policy at the URL provided.

### 2.3 Save

Click **Save Changes** at the bottom. Some fields (App Domains, category) may unlock only after the URLs are validated by Meta — this can take 30 seconds. If a field bounces back, re-check the URL is live, refresh, retry.

### 2.4 App icon confirmation

Verify the icon appears at the top of the Settings → Basic page after upload. If it looks pixelated, your PNG was smaller than 1024 × 1024 — re-export.

---

## Phase 3 — Meta Business Manager: Business Verification (30 – 45 minutes)

Go to **[business.facebook.com](https://business.facebook.com)** → sign in with the same Facebook account tied to the app → **Business Settings** (gear icon top-right) → **Security Center** (left sidebar).

You should see a **"Business Verification"** card with a **"Start Verification"** button. If instead you see "Verification Complete" you're already good — jump to Phase 4.

### 3.1 Confirm business info

Meta will ask you to confirm the info they have on file. Answer as follows:

| Field | Value |
|---|---|
| **Legal name of business** | *your name as on PAN, exactly* — for example `Meet Kabra` |
| **Business address** | *your registered address exactly as on Aadhaar / utility bill* |
| **Business phone number** | *your active mobile in international format* — `+91XXXXXXXXXX` |
| **Business email** | `help.bharatresume@gmail.com` |
| **Business website** | `https://bharat-resume-production.up.railway.app` |
| **Country** | `India` |

Click **Next**.

### 3.2 Upload documents

Meta will now ask you to upload proof of the business. This is the make-or-break screen.

For a **Sole Proprietorship in India**, upload BOTH:

**Document 1 — Legal name proof:**
- Upload your **PAN Card** (front). File type: PDF or JPG, under 5 MB.

**Document 2 — Business address / legitimacy proof:**
- Preferred: **Udyam Registration Certificate**. It has both your name and registered business address in one document — the cleanest pass.
- Fallback if no Udyam: upload your **Utility Bill** (electricity / gas / landline, last 3 months, in your name at the registered address).
- Fallback 2: **Bank statement** (last 3 months) showing name + address + account. Redact the transaction lines if you prefer.

Click **Next**.

### 3.3 Verification method

Meta will offer 1 – 2 methods to verify contact:

- ✅ **Verify by email** — cheapest, most reliable. Meta sends a code to `help.bharatresume@gmail.com`. Paste the 6-digit code back.
- Optional: **Verify by phone (SMS/call)** — Meta sends OTP to your registered mobile. Works too. Use both if offered.

### 3.4 Submit

Click **Submit for Verification**. You will land on a "Under Review" screen. **Do not resubmit, do not close, do not edit the business info now.** Any change re-starts the clock.

Meta's stated SLA is 2 – 5 business days. In practice most Indian small-business submissions come back in 1 – 3 days.

---

## Phase 4 — While you wait (parallel work you can start immediately)

- [ ] Confirm all 5 test recipients on your Meta WhatsApp allowlist are still current (some phone numbers might have changed since June).
- [ ] Confirm `PILOT_MODE=true` is still set on Railway.
- [ ] Confirm `PHONE_HASH_SECRET` is set on Railway (long random string — no security warning at boot).
- [ ] Set the hard **OpenAI spend cap** to $30/month at [platform.openai.com/settings/organization/limits](https://platform.openai.com/settings/organization/limits).
- [ ] Set up **UptimeRobot** free monitor pinging `/health` every 5 minutes.
- [ ] Draft your **student invitation message** (see below).
- [ ] Choose your **first 5 heavy testers** (per the two-day launch strategy) — get their WhatsApp numbers on the Meta allowlist immediately so you can test the moment BV is approved.

### 4.1 Student invitation message (Meta-template safe)

Meta requires that the FIRST outbound message to any student outside a 24-hour window uses a pre-approved template. This one is deliberately transactional and utility-only so it will pass:

> Namaste 👋 We're launching **Bharat Resume**, a WhatsApp AI resume builder for JECRC students. Free during pilot week. Reply *YES* to start — it takes ~10 minutes and you'll receive a fully ATS-tuned PDF. Reply *STOP* to opt out.

You submit this template in Meta Business Manager → **WhatsApp Manager** → **Message Templates** → **Create Template** → category **UTILITY**, language English. Template approval usually takes 1 – 2 hours.

---

## Phase 5 — When Meta approves (email arrives from Meta)

You'll receive an email from Meta subject **"Your business has been verified"**. Then:

1. Go back to the App Dashboard → App Review → App Mode → toggle from **Development** to **Live**. The toggle is greyed out until Business Verification is complete — that's your green light.
2. Submit WhatsApp Business Cloud API for **Advanced Access review** if you haven't already. Auto-approved usually, since we're on the standard messaging use case.
3. Add all 100 student phone numbers to the **allowed message recipients** list (some tiers no longer need this; if the field is gone, you're free to broadcast).
4. Send the approved template message to your first wave of testers.
5. Watch UptimeRobot + Railway logs.

---

## What to do if Meta rejects verification

Common rejection reasons and fixes:

| Rejection reason | Fix |
|---|---|
| "Documents don't match the business info" | Re-check the exact spelling of legal name and address across PAN, Aadhaar, utility bill, and the form. Any mismatch fails — even `Kumar` vs `kumar`. |
| "Website doesn't clearly describe the business" | Add a real landing page at the root URL of the Railway domain. Currently `/` returns nothing — Meta reviewers want a homepage that explains the product. (We can build this in an hour if needed.) |
| "Cannot verify business legitimacy" | Upload the Udyam Registration Certificate as an additional document. Get registered at [udyamregistration.gov.in](https://udyamregistration.gov.in) if you're not yet. |
| "Additional documentation required" | Meta sometimes just wants a second look. Reply to the notification with any of: GST certificate (if you have one), business bank statement, or a photo of your workspace with the Bharat Resume branding visible. |

Do NOT open a new appeal thread — reply on the existing one. Meta closes duplicate threads and re-starts your clock.

---

## Files created for this verification (paths in the repo)

| File | URL when deployed |
|---|---|
| `public/privacy.html` | `/privacy` |
| `public/terms.html` | `/terms` |
| `public/data-deletion.html` | `/data-deletion` |
| `docs/META_VERIFICATION_GUIDE.md` | *(this guide — for your reference)* |

Routes are wired in `src/routes/admin.js`. Server config unchanged; no new env vars required.

---

**Final reminder:** submit once, wait, do not touch. Every edit or resubmission during review restarts the SLA. If you need to change anything mid-review, wait for Meta to come back with a rejection or approval first.
