// Saathi's outbound messages, keyed by state. PRD §5.
// Voice rules: Latin script only. Warm elder-cousin tone. ≤2 mobile lines.
// 3-5 variants per state — pickPrompt() chooses randomly so two students get
// different conversational flavors.
const { STATES } = require('./states');

const PROMPTS = {
  [STATES.NEW]: [
    "Hey! I'm Saathi from BHARAT RESUME. Aapka professional resume 10 min mein bana denge — chat in Hinglish or English, jo comfortable ho. Ready? Reply 'yes' / 'haan' to start.",
    "Namaste! Saathi here — BHARAT RESUME ka AI bot. Resume bana denge ~10 min mein. Hinglish or English, both fine. Shall we start? Type 'yes' or 'haan'.",
    "Hi! Main Saathi hu — I'll build your professional resume in about 10 minutes. Hinglish/English chalega. Shuru karein? Reply 'yes' / 'ready'.",
    "Hello! Saathi from BHARAT RESUME — 10 min mein professional resume ready. Chat in whatever you prefer: English, Hinglish, mix. Type 'haan' / 'yes' to begin.",
  ],

  // Warmer fallbacks for when the user sends something other than yes/haan/ready.
  // Acknowledges the contact + sets expectation + ends with a clear CTA.
  [STATES.AWAITING_CONFIRM_START]: [
    "Hi! Saathi here — chaliye aapka resume banate hain. Reply 'yes' or 'haan' to start.",
    "Hey! Bas 'yes' likh dijiye aur 10 min mein resume ready. Chalein?",
    "Namaste! Resume banate hain saath mein. Type 'yes' / 'haan' / 'ready' to begin.",
    "Saathi ready hai ✓ Reply 'yes' / 'haan' to kick off — aapka professional resume 10 min mein tayar.",
  ],

  [STATES.AWAITING_NAME]: [
    "Pehle aapka pura naam batayiye?",
    "Let's start basic — what's your full name?",
    "Full name kya hai aapka?",
    "First up: your full name please.",
  ],

  [STATES.AWAITING_EMAIL]: [
    "Email ID share kar dijiye?",
    "What's your email ID?",
    "Cool. Ab email bhejiye.",
    "Drop your email here.",
  ],

  [STATES.AWAITING_LINKEDIN]: [
    "LinkedIn URL bhejiye? Type 'skip' agar nahi hai.",
    "Share your LinkedIn profile (or 'skip').",
    "LinkedIn ka link? 'skip' likh dijiye agar nahi hai.",
    "LinkedIn profile link? 'skip' if you don't have one.",
  ],

  [STATES.AWAITING_GITHUB]: [
    "GitHub profile? Link bhej dijiye, ya 'skip'.",
    "GitHub link share kariye, warna 'skip'.",
    "Got a GitHub? Drop the link, otherwise type 'skip'.",
    "GitHub URL? 'skip' if you don't have one.",
  ],

  [STATES.AWAITING_EDUCATION]: [
    "Apni padhai ki details bhejiye — degree, college, branch, expected graduation year, sab ek message mein.",
    "Tell me about your degree — course + college + branch + expected year, all in one message.",
    "Education details: degree, college ka naam, branch, expected year of passing. Ek saath bhej dijiye.",
    "Share your education: which degree, which college, branch, year of passing — single message please.",
  ],

  [STATES.AWAITING_CGPA]: [
    "CGPA ya percentage kya hai?",
    "What's your CGPA (or percentage)?",
    "Score batayiye — CGPA ya % whichever.",
    "Aapka academic score? CGPA / percentage, koi bhi.",
  ],

  // JD step now offers THREE paths: full JD, role-name only, or generic.
  // PRD §5 step 7 amended on 2026-06-21 — see Decisions log.
  [STATES.AWAITING_JD]: [
    "Ab us job ka Naukri link bhejiye, ya JD ka text paste kar dijiye. Bas role ka naam (jaise 'Software Engineer') bhi chalega. 'No specific role' bolo if generic resume chahiye.",
    "Which job are you targeting? Share the Naukri URL, paste JD text, or just type the target role (e.g., 'Data Analyst'). Or 'no specific role' for generic.",
    "Job ka link / JD / role name — kuch bhi bhej dijiye. Naukri URL, raw JD text, ya simply 'Backend Developer' jaisa role title. 'No specific role' agar koi specific nahi hai.",
    "Target job — drop the Naukri link, paste JD text, OR just the role title (e.g., 'Frontend Engineer'). Say 'no specific role' for a role-agnostic resume.",
  ],

  [STATES.AWAITING_SKILLS]: [
    "Kaun kaun si skills aati hain? Programming languages, frameworks, tools — casually likh dijiye.",
    "List your skills — programming languages, frameworks, tools, libraries, anything relevant.",
    "Skills batayiye: languages, libraries, tools, databases — jo bhi aata hai sab.",
    "What skills do you have? Languages, frameworks, tools — drop them all in one message.",
  ],

  [STATES.AWAITING_COURSEWORK]: [
    "Koi relevant coursework hai jo highlight karna chahte ho? Jaise DSA, ML, Stats, DBMS, etc. 'skip' if none.",
    "Any relevant coursework worth highlighting? (DSA, Machine Learning, Statistics, OS, DBMS, etc.) Or 'skip'.",
    "Coursework jo aapko strong banata ho — DSA, AI, Probability, Networks? List kar dijiye, ya 'skip'.",
    "Top coursework — kuch jo role ke liye relevant ho. Comma-separated batayiye ya 'skip' if none.",
  ],

  // Experience prompt explicitly invites action+impact+tools — primes the LLM
  // sufficiency check that runs in extract.js.
  [STATES.AWAITING_EXPERIENCE]: [
    "Koi internship ya job experience? Company, role, dates, kya kiya, aur impact kya tha (% improve / users / time saved) — ek saath. 'skip' if none.",
    "Any internship/work experience? Drop company + role + dates + what you DID + the impact (numbers, results, deliverable). Or 'skip'.",
    "Work experience? Company, role, duration, ek concrete action, aur outcome — sab batao. Type 'skip' if not.",
    "Internships/jobs share kariye — kahaan, kya role, kya banaya/improve kiya, kya result mila. 'skip' agar nahi hai.",
  ],

  // Projects prompt asks for description + LINK so we can auto-enrich from GitHub.
  [STATES.AWAITING_PROJECTS]: [
    "Projects share kariye — ek project per message. Name + GitHub link + 2-3 lines kya banaya. Multiple projects ho to ek-ek karke. 'done' jab sab bata den, 'skip' if none.",
    "Tell me about your projects — one per message. Name, the GitHub link (or live URL), and a short description. Type 'done' when finished, 'skip' if none.",
    "Koi projects? Har project alag message: name, GitHub link, brief description. 'done' for finish, 'skip' for none. GitHub link ho to bhej dena — main repo se details pick kar lunga.",
    "Projects batao — one at a time. Include name + GitHub link + what it does. I'll pull tech stack and details from the repo. Type 'done' when complete, 'skip' if nothing.",
  ],

  // PoR step: jargon dropped, plain language used per Meet's feedback.
  [STATES.AWAITING_POR]: [
    "Koi leadership ya responsibility role hai? Class representative, club head, event organizer, NSS/NCC — kuch aisa. 'skip' if none.",
    "Any leadership role at college? — class rep, society head, event lead, NSS/NCC, etc. 'skip' for none.",
    "Leadership ya responsibility hai kuch — class rep, club, society, event organizer, NSS/NCC? Drop it here ya 'skip'.",
    "Held a leadership/responsibility role at college? Like class rep, club lead, society head, event organizer, NSS/NCC. 'skip' if not.",
  ],

  // Certs: just name + link. No more issuer/date follow-ups (Day 4 template
  // renders as a clickable hyperlink — name as text, link as href).
  [STATES.AWAITING_CERTS]: [
    "Certifications ya courses? Naam aur verification link bhejiye (NPTEL/Coursera/AWS/etc.). Multiple ho to ek-ek karke. 'skip' if none.",
    "Any certifications? Share name + verification URL (Coursera / NPTEL / AWS / Udemy / etc.) — one per message if multiple. 'skip' for none.",
    "Certifications/courses kiye hain? Drop name + link (verification URL). 'skip' if nothing comes to mind.",
    "Share certifications — just the name and the link. I'll handle issuer + date from the URL. 'skip' if none.",
  ],

  [STATES.AWAITING_ACHIEVEMENTS]: [
    "Last one — koi achievements, ranks, prizes? List kar dijiye. 'skip' / 'no' if nothing comes to mind.",
    "Final section: any achievements, awards, or prizes? Or 'skip' / 'no'.",
    "Awards/ranks/prizes? Sab batayiye, ek saath. 'skip' or 'no' if none.",
    "Last question: notable achievements, competitions, awards? Or 'skip' / 'no' to wrap up.",
  ],
};

const MESSAGES = {
  rateLimit: [
    "Whoa, slow down — try again in {sec}s.",
    "Bahut tez messages aa rahe hain. {sec}s wait kariye.",
    "Easy easy! {sec}s baad try kariye phir.",
  ],

  reset: [
    "Session cleared ✓",
    "Reset done.",
    "Fresh start ready.",
  ],

  projectSaved: [
    "Project #{n} saved ✓ — agla project bhejo, ya 'done' likho.",
    "Saved! Project {n} locked in. Add another, or type 'done'.",
    "{n} project(s) stored ✓ — keep going, or 'done' when finished.",
    "Got it — project #{n} ✓. Add more, or 'done' to wrap projects.",
  ],

  extractFail: [
    "Hmm, samajh nahi aaya. Ek baar phir bhej dijiye?",
    "Could you rephrase that?",
    "Confused ho gaya — try again?",
    "Didn't quite catch that. One more time?",
  ],

  serverError: [
    "Server pe kuch issue hai. 30s baad try kariye.",
    "Hmm, something broke. Give it 30s and retry.",
    "Backend hiccup — try again in a moment.",
  ],

  // When AWAITING_JD gets a "no specific role" / generic request.
  jdGenericAck: [
    "Cool — generic resume banayenge. Skills + experience emphasize karenge.",
    "Got it, no specific JD. Building a role-agnostic resume.",
    "Theek hai — generic resume mode on. Aapki overall strength highlight karenge.",
  ],

  // When AWAITING_JD gets just a role name (e.g., "Software Engineer").
  jdRoleAck: [
    "Cool — '{role}' ke liye tailor karenge ✓",
    "Got it. Targeting '{role}' — bullets and summary will lean into that.",
    "Locked: '{role}' role focus mein rakhenge.",
    "Theek hai — '{role}' ko target karke resume banayenge.",
  ],

  // Used as a fallback only — Day 3 now actually generates inline.
  generatingDone: [
    "Bas! All details collected ✓ Saathi resume bana raha hai — 30s do.",
    "Done collecting ✓ Resume tailoring in progress.",
    "Sab data ready ✓ Generating your tailored resume now.",
  ],

  generationFailed: [
    "Resume generation atak gayi. Type 'reset' to start over, ya try again in a moment.",
    "Generation hit a snag. Try again with 'reset', or message me in 30s.",
    "Couldn't finish the rewrite. Reset and try again — backend hiccup most likely.",
  ],

  deliveredHelp: [
    "Watermarked resume bhej diya ☝️ Type 'edit' to refine (3 free edits), ya 'pay' to unlock the clean ATS-readable version for ₹49 (+ 3 more edits).",
    "Aapka watermarked PDF upar hai. 'edit' for changes (3 included), ya 'pay' to unlock the clean version — ₹49, plus 3 edits.",
    "Resume tayar (watermarked). 'edit' to tweak (3 free), or 'pay' for the clean Naukri-readable PDF — ₹49 and 3 more edits.",
  ],

  // Sent when the student types 'pay' — carries the Razorpay short URL.
  paymentLink: [
    "Yahan se ₹49 pay kar dijiye, clean PDF turant aa jayega 👇\n{url}",
    "Almost there! Pay ₹49 here and I'll send the clean ATS-readable resume right away:\n{url}",
    "Clean version unlock karne ke liye ₹49 here 👇 Payment ke baad PDF auto-deliver:\n{url}",
  ],

  paymentLinkFailed: [
    "Payment link banane mein dikkat aa gayi. 30s baad 'pay' phir try kariye.",
    "Couldn't create the payment link just now — type 'pay' again in a moment.",
    "Hmm, link generate nahi hua. Thoda ruk ke 'pay' dobara bhejiye.",
  ],

  // Student messages while we're waiting on the Razorpay webhook.
  awaitingPayment: [
    "Payment ka wait kar raha hu ⏳ Pay here and the clean PDF auto-arrives:\n{url}",
    "Bas payment hote hi clean resume bhej dunga. Link:\n{url}",
    "Waiting for your ₹49 payment ⏳ Once done, clean PDF comes automatically:\n{url}",
  ],

  paidComplete: [
    "Payment ho chuka hai ✓ Clean resume bhej diya. Type 'edit' for changes (3 included), ya 'reset' for a fresh one. All the best! 🎉",
    "Done & paid ✓ Clean ATS-readable resume deliver ho gaya. 'edit' to refine (3 edits), 'reset' to start over. Good luck!",
    "Sab set ✓ Clean version sent. 'edit' for tweaks (3 included), 'reset' for a fresh resume anytime.",
  ],

  // --- Edit loop (Day 5.3). Free phase (pre-payment) and paid phase share these. ---

  // Entering edit mode — ask what to change, show remaining budget.
  editPrompt: [
    "Kya change karna hai? Ek line mein batao — e.g. 'CGPA 8.6 karo', 'last project hatao', 'summary chhoti karo'. ({remaining} edits left)",
    "What should I change? One line — like 'fix my email', 'remove the 2nd bullet', 'shorten the summary'. ({remaining} edits left)",
    "Batao kya edit karna hai — ek line. ({remaining} edits remaining)",
  ],

  // Edit applied — PDF re-attached above. Free phase.
  editApplied: [
    "Updated ✓ {remaining} free edits left. Type 'edit' for another change, ya 'pay' to unlock the clean PDF.",
    "Done ✓ Naya version upar hai. {remaining} free edits bache. 'edit' for more, 'pay' for the clean copy.",
    "Changed ✓ {remaining} edits left. Keep editing with 'edit', or 'pay' for the ATS-readable version.",
  ],

  // Edit applied — paid phase (clean PDF re-attached).
  editAppliedPaid: [
    "Updated ✓ {remaining} edits left. Type 'edit' for another change.",
    "Done ✓ Clean resume re-sent above. {remaining} edits remaining. 'edit' for more.",
    "Changed ✓ {remaining} edits left. 'edit' anytime for another tweak.",
  ],

  // Free edits exhausted → the nudge to pay (and the promise of 3 more after).
  editCapFree: [
    "Aapke 3 free edits ho gaye 💪 Resume already strong hai — ₹49 pay karke clean PDF lo, aur main 3 aur edits kar dunga uspe. Type 'pay'.",
    "That's all 3 free edits done 💪 Pay ₹49 for the clean ATS-readable PDF and you get 3 MORE edits on it. Type 'pay'.",
    "3 free edits complete ✓ Clean version unlock karo ₹49 mein — plus 3 fresh edits included. Type 'pay'.",
  ],

  // Paid edits exhausted → final.
  editCapPaid: [
    "Aapke 3 post-payment edits bhi ho gaye — resume ab final hai ✓ Type 'reset' for a brand-new resume anytime.",
    "All 3 paid edits used ✓ Your clean resume is final. 'reset' if you want to build a fresh one.",
    "That's the last edit ✓ Resume locked in. Type 'reset' to start a new one from scratch.",
  ],

  // Student typed 'done' to leave edit mode.
  editDone: [
    "Cool ✓ Jab ready ho 'pay' likho clean PDF ke liye, ya 'edit' for more changes.",
    "Got it ✓ Type 'pay' when you want the clean copy, or 'edit' to tweak more.",
    "Done editing for now ✓ 'pay' to unlock, 'edit' to change something else.",
  ],

  editDonePaid: [
    "Done ✓ Clean resume already aapke paas hai. 'edit' anytime for more changes.",
    "Cool ✓ Your clean resume is delivered. Type 'edit' whenever you want another tweak.",
    "All set ✓ 'edit' for more changes, 'reset' for a fresh resume.",
  ],

  editFailed: [
    "Edit apply nahi hua — ek baar phir bhejiye? Ya 'done' to keep the current version.",
    "Couldn't apply that change — try rephrasing? Or 'done' to keep it as is.",
    "Hmm, that edit didn't go through. One more time, or 'done' to keep current.",
  ],

  beyondPhase2: [
    "Day 2 yahin tak hai. Rewrite + PDF + ATS scoring Day 3+ mein. Use 'show me' to view data, 'reset' to restart.",
    "We're at the edge of Day 2 build. Try 'show me' to view collected data, or 'reset' to start over.",
    "Day 3 features coming soon. For now: 'show me' for current state, 'reset' for a fresh attempt.",
  ],
};

function pick(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickPrompt(state) {
  const p = PROMPTS[state];
  if (!p) return null;
  return pick(p);
}

function pickMessage(key, vars = {}) {
  const m = MESSAGES[key];
  if (!m) return key;
  let s = pick(m);
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return s;
}

module.exports = { PROMPTS, MESSAGES, pickPrompt, pickMessage };
