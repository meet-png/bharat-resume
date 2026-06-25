// Saathi's outbound messages, keyed by state. PRD §5.
// Voice rules: Latin script only. Warm elder-cousin tone. ≤2 mobile lines.
// 3-5 variants per state — pickPrompt() chooses randomly so two students get
// different conversational flavors.
const { STATES } = require('./states');

const PROMPTS = {
  [STATES.NEW]: [
    "Hey! I'm Saathi from BHARAT RESUME. Aapka professional resume ~10 min mein bana denge — chat in Hinglish or English, jo comfortable ho.\n\n_Commands:_ 'reset' = start over · 'skip' = skip an optional question · 'done' = finish a multi-item section (projects/certs/jobs).\n\nReady? Reply 'yes' / 'haan' to start.",
    "Namaste! Saathi here — BHARAT RESUME ka AI bot. ~10 min mein resume tayar.\n\n_Useful at any time:_ 'reset' starts fresh · 'skip' skips an optional question · 'done' wraps up a section with multiple entries.\n\nShall we begin? Type 'yes' / 'haan'.",
    "Hi! Main Saathi hu — I'll build your professional resume in about 10 minutes. Hinglish/English chalega.\n\n_Quick commands:_ 'reset' = fresh start · 'skip' = skip optional · 'done' = finish multi-entry sections.\n\nShuru karein? Reply 'yes' / 'ready'.",
    "Hello! Saathi from BHARAT RESUME — 10 min mein professional resume ready. Chat in whatever you prefer.\n\n_Anytime commands:_ 'reset' restarts · 'skip' jumps optional questions · 'done' closes a multi-entry section.\n\nType 'haan' / 'yes' to begin.",
  ],

  // Warmer fallbacks for when the user sends something other than yes/haan/ready.
  // Acknowledges the contact + sets expectation + ends with a clear CTA.
  [STATES.AWAITING_CONFIRM_START]: [
    "Hi! Saathi here — chaliye aapka resume banate hain. Reply 'yes' or 'haan' to start. (Anytime: 'reset' = start over, 'skip' = skip an optional question.)",
    "Hey! Bas 'yes' likh dijiye aur ~10 min mein resume ready. ('reset' anytime to start fresh.) Chalein?",
    "Namaste! Resume banate hain saath mein. Type 'yes' / 'haan' / 'ready' to begin. ('skip' kabhi bhi optional skip karne ke liye, 'reset' fresh start.)",
    "Saathi ready hai ✓ Reply 'yes' / 'haan' to kick off. Tip — 'reset' starts over, 'skip' jumps an optional question.",
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

  [STATES.AWAITING_CODING_PROFILES]: [
    "Coding profile? LeetCode / Codeforces / CodeChef ka link bhejiye — saath mein problems solved ya rating ho toh likh dijiye (e.g. 'leetcode.com/u/me, 450+ solved'). Ya 'skip'.",
    "Competitive coding profiles? Share your LeetCode / Codeforces / CodeChef link(s) + problems solved or rating if you have it. Or 'skip'.",
    "LeetCode / Codeforces / GFG link + kitne problems solve kiye ya rating — bhej dijiye, warna 'skip'.",
    "Any coding profiles (LeetCode, Codeforces, CodeChef…)? Drop the link(s) and your solved-count/rating, or type 'skip'.",
  ],

  [STATES.AWAITING_EDUCATION]: [
    "Apni padhai ki details bhejiye — degree, college, branch, expected graduation year, sab ek message mein.",
    "Tell me about your degree — course + college + branch + expected year, all in one message.",
    "Education details: degree, college ka naam, branch, expected year of passing. Ek saath bhej dijiye.",
    "Share your education: which degree, which college, branch, year of passing — single message please.",
  ],

  // CGPA is optional (added to OPTIONAL_STATES 2026-06-25). Make the prompt
  // explicit so the student knows they can skip without explanation.
  [STATES.AWAITING_CGPA]: [
    "CGPA ya percentage kya hai? 'skip' agar share nahi karna.",
    "What's your CGPA (or percentage)? Type 'skip' if you'd rather not share.",
    "Score batayiye — CGPA ya % whichever. 'skip' if you prefer not to.",
    "Aapka academic score? CGPA / percentage / 'skip' — koi bhi chalega.",
  ],

  // JD step now offers THREE paths: full JD, role-name only, or generic.
  // PRD §5 step 7 amended on 2026-06-21 — see Decisions log.
  [STATES.AWAITING_JD]: [
    "Ab us job ka Naukri link bhejiye, ya JD ka text paste kar dijiye. Bas role ka naam (jaise 'Software Engineer') bhi chalega. 'No specific role' bolo if generic resume chahiye.",
    "Which job are you targeting? Share the Naukri URL, paste JD text, or just type the target role (e.g., 'Data Analyst'). Or 'no specific role' for generic.",
    "Job ka link / JD / role name — kuch bhi bhej dijiye. Naukri URL, raw JD text, ya simply 'Backend Developer' jaisa role title. 'No specific role' agar koi specific nahi hai.",
    "Target job — drop the Naukri link, paste JD text, OR just the role title (e.g., 'Frontend Engineer'). Say 'no specific role' for a role-agnostic resume.",
  ],

  // Role-aware (keyed by domain — see roleDomain()). Technical roles get the
  // languages/frameworks phrasing; everyone else gets a generic, non-coding ask
  // so a Marketing Manager isn't asked for "programming languages".
  [STATES.AWAITING_SKILLS]: {
    technical: [
      "Kaun kaun si skills aati hain? Programming languages, frameworks, tools — casually likh dijiye.",
      "List your skills — programming languages, frameworks, tools, libraries, anything relevant.",
      "Skills batayiye: languages, libraries, tools, databases — jo bhi aata hai sab.",
      "What skills do you have? Languages, frameworks, tools — drop them all in one message.",
    ],
    general: [
      "Kaun kaun si skills aati hain? Tools, software, aur methods jo aap kaam mein use karte ho — sab casually likh dijiye.",
      "List your key skills — tools, software, techniques, anything relevant to your work.",
      "Apni skills batayiye: jo bhi tools, software ya methods aate hain — sab ek message mein.",
      "What are your main skills? Tools, software, methods you use — drop them all in one message.",
    ],
  },

  // Role-aware coursework prompt. We deliberately AVOID pre-listing canonical
  // course names ("DSA, ML, Stats, DBMS") because it primes the student to think
  // we only accept those — and the friend-test 2026-06-25 looped on "Fast API"
  // being rejected against that hidden whitelist. The prompt is now open-ended:
  // "anything relevant to YOUR role." The extractor (extract.js) accepts
  // whatever they name. For technical roles we hint at the breadth (frameworks,
  // domain topics, modern tools) without naming specific examples; non-tech
  // roles get a domain-agnostic ask.
  [STATES.AWAITING_COURSEWORK]: {
    technical: [
      "Koi relevant coursework / topics / frameworks aapne padhe ho jo is role ke liye important hain? Anything counts — academic subjects, modern tools, libraries. Comma-separated bhej dijiye, ya 'skip'.",
      "Any coursework, topics, or frameworks you've studied that fit this role? Could be classical subjects OR modern tools — whatever you've actually learned. List them, or 'skip'.",
      "Coursework ya topics jo aapne is role ke liye padhe hain — academic subjects, frameworks, koi bhi. Comma-separated, ya 'skip' if none.",
      "Relevant coursework / study topics / frameworks for this role? Anything you've covered counts. Drop the list or 'skip'.",
    ],
    general: [
      "Koi relevant subjects ya coursework jo aapke field mein important hain? Comma-separated batayiye, ya 'skip' if none.",
      "Any key subjects or coursework from your field worth highlighting? List them, or 'skip'.",
      "Apne course ke woh subjects batayiye jo is role ke liye strong hain — ya 'skip' agar koi nahi.",
      "Relevant coursework / subjects for this role? Comma-separated, ya 'skip' if none.",
    ],
  },

  // Experience prompt explicitly invites action+impact+tools — primes the LLM
  // sufficiency check that runs in extract.js.
  [STATES.AWAITING_EXPERIENCE]: [
    "Koi internship ya job experience? Company, role, dates, kya kiya, aur impact kya tha (% improve / users / time saved) — ek saath. 'skip' if none.",
    "Any internship/work experience? Drop company + role + dates + what you DID + the impact (numbers, results, deliverable). Or 'skip'.",
    "Work experience? Company, role, duration, ek concrete action, aur outcome — sab batao. Type 'skip' if not.",
    "Internships/jobs share kariye — kahaan, kya role, kya banaya/improve kiya, kya result mila. 'skip' agar nahi hai.",
  ],

  // Role-aware. Technical roles get the GitHub-centric ask (we auto-enrich from
  // the repo); non-technical roles get a link-agnostic ask so a Marketing /
  // Sales / Finance candidate isn't told to paste a GitHub link.
  [STATES.AWAITING_PROJECTS]: {
    technical: [
      "Projects share kariye — ek project per message. Name + GitHub link + 2-3 lines kya banaya. Multiple projects ho to ek-ek karke. 'done' jab sab bata den, 'skip' if none.",
      "Tell me about your projects — one per message. Name, the GitHub link (or live URL), and a short description. Type 'done' when finished, 'skip' if none.",
      "Koi projects? Har project alag message: name, GitHub link, brief description. 'done' for finish, 'skip' for none. GitHub link ho to bhej dena — main repo se details pick kar lunga.",
      "Projects batao — one at a time. Include name + GitHub link + what it does. I'll pull tech stack and details from the repo. Type 'done' when complete, 'skip' if nothing.",
    ],
    general: [
      "Projects ya major kaam share kariye — ek per message. Naam + 2-3 lines kya kiya/banaya. 'done' jab sab ho jaye, 'skip' if none.",
      "Tell me about your projects or key work — one per message. Name + a short description of what you did. Type 'done' when finished, 'skip' if none.",
      "Koi projects, campaigns ya initiatives? Har ek alag message: naam + brief description. 'done' for finish, 'skip' for none.",
      "Projects ya key work batao — one at a time. Name + what it achieved. Agar kuch public hai (live site / article / deck) to link bhi bhej dena. 'done' when complete, 'skip' if nothing.",
    ],
  },

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

  serverError: [
    "Server pe kuch issue hai. 30s baad try kariye.",
    "Hmm, something broke. Give it 30s and retry.",
    "Backend hiccup — try again in a moment.",
  ],

  // Sent when a student fires a new message while their previous one is still
  // being processed (e.g. resume is mid-generation). Their text isn't dropped —
  // we just ask them to wait so two messages don't race on the session.
  busy: [
    "Ek sec — aapka pichla message abhi process ho raha hai. Thoda ruk ke bhejiye 🙏",
    "Hang on — still working on your last message. Give me a few seconds and resend.",
    "Abhi ek kaam chal raha hai ⏳ Bas thodi der mein dobara bhejiye.",
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

  // Pilot students typed 'pay' but already have the clean PDF for free.
  pilotNoPay: [
    "No payment needed 🎉 Aapko clean ATS-readable PDF already mil chuka hai — bilkul free. Type 'edit' to refine it.",
    "It's on us ✓ Aapka clean resume already unlocked hai — koi ₹49 nahi. 'edit' to make changes.",
    "Free pilot ✨ Clean PDF already deliver ho chuka — nothing to pay. 'edit' for any tweaks.",
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

  // PDF render/upload failed during initial generation. NO success preview, NO
  // "check server logs" — just a clear, retryable failure message. The state
  // machine stays in GENERATING so the next inbound message retries.
  pdfDeliveryFailed: [
    "PDF banane mein dikkat aa gayi 😕 Thoda ruk ke koi bhi message bhejiye — main dobara try karunga.",
    "Resume PDF abhi generate nahi ho payi. 30s baad ek message aur bhejiye, main turant retry karunga.",
    "Oops — PDF deliver nahi ho payi. Koi message bhejiye aur main phir se bana ke bhejta hu.",
  ],

  // Edit applied to the data but the re-render failed. Change is saved on the
  // session; no edit consumed; student can retry 'edit'.
  editPdfFailed: [
    "Change save ho gaya, par naya PDF abhi nahi ban paya. Thodi der mein 'edit' phir bhejiye — wahi change dobara apply ho jayega.",
    "Aapka edit set hai, lekin PDF re-generate nahi hui. Thoda ruk ke 'edit' dobara try kariye.",
  ],

  // Deterministic impact ask for the experience step — used when the LLM tries
  // to re-ask an already-filled hard slot (role/company/dates).
  expAskImpact: [
    "Aur ek baat — is kaam ka impact kya raha? Koi number ya result (jaise % improve, reach, time saved)?",
    "Thoda impact bata dijiye — kya result/outcome mila? Koi specific number ho to best.",
    "Last bit: is experience ka concrete result kya tha — number ya measurable outcome?",
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

// Coarse technical-vs-general split used to pick role-aware prompts (skills,
// projects). Deliberately an allow-list of clearly technical roles — anything
// not matched falls back to 'general', because generic phrasing reads fine for
// a developer too, whereas tech phrasing alienates a non-technical candidate.
const TECHNICAL_ROLE_RE = /\b(software|developer|dev|programmer|coder|engineer|engineering|data scien|data analyst|data engineer|machine learning|\bml\b|\bai\b|deep learning|devops|\bsre\b|backend|back-end|frontend|front-end|full.?stack|web dev|mobile dev|android|ios|\bqa\b|sdet|test engineer|automation engineer|cloud|security engineer|cyber|\bdba\b|database admin|embedded|firmware|systems? engineer|game dev|blockchain|programming)\b/i;

function roleDomain(session) {
  if (!session) return 'general';
  const hay = [session.jd_role, session.jd_text].filter(Boolean).join(' ');
  if (hay && TECHNICAL_ROLE_RE.test(hay)) return 'technical';
  return 'general';
}

function pickPrompt(state, session) {
  const p = PROMPTS[state];
  if (!p) return null;
  if (Array.isArray(p)) return pick(p);
  // Role-aware prompt: object keyed by domain ('technical' | 'general').
  const domain = roleDomain(session);
  return pick(p[domain] || p.general || p.technical);
}

// Deterministic, slot-scoped question for the experience step. Asks ONLY for the
// hard slots still empty (role/company/dates) so a filled slot is never re-asked.
function expSlotQuestion(missing) {
  const labels = {
    role: 'aapka role / designation',
    company: 'company ka naam',
    dates: 'duration (kab se kab tak)',
  };
  const parts = (missing || []).map((k) => labels[k] || k);
  if (parts.length === 0) return null;
  let ask;
  if (parts.length === 1) ask = parts[0];
  else if (parts.length === 2) ask = parts[0] + ' aur ' + parts[1];
  else ask = parts.slice(0, -1).join(', ') + ' aur ' + parts[parts.length - 1];
  return `Bas itna aur batayiye — ${ask}?`;
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

module.exports = { PROMPTS, MESSAGES, pickPrompt, pickMessage, roleDomain, expSlotQuestion };
