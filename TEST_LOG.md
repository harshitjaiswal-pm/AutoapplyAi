# AutoApply AI — Application Test Log
Session started: 2026-04-14

## App 1 — ZURU Edge — Business Analyst — 2026-04-14
URL: https://jobs.lever.co/zuruedge/...
Platform: Lever ATS (via LinkedIn)
Status: SUBMITTED ✓
Resume: Tailored for ZURU Edge BA role
Notes: Wrong filename bug (Resume - Jobs - Business Analyst.pdf vs Resume - ZURU Edge - ...) — fix pending

## App 2 — Mistplay — Senior Business Operations Analyst I — 2026-04-14
URL: https://www.linkedin.com/jobs/view/4401590184
Platform: LinkedIn Easy Apply
Status: SUBMITTED ✓
Resume: Tailored via AutoApply
Notes: LinkedIn Easy Apply — submitted directly on platform

## App 3 — Walmart Connect Canada — (CAN) Senior Analyst, Business Analysis and Insights - UX/UI — 2026-04-14
URL: https://walmart.wd5.myworkdayjobs.com/WalmartExternal/job/Mississauga-ON/...
Platform: Workday
Status: IN PROGRESS — Workday sign-in required, account creation needed via AutoApply Pro
Notes: Tab closed unexpectedly; will retry


## App 2 UPDATE — Walmart Connect Canada — ALREADY APPLIED (March 5, 2026)
URL: https://walmart.wd5.myworkdayjobs.com/.../R-2425054
Platform: Workday
Status: PREVIOUSLY SUBMITTED (March 5, 2026) — skipping, not reapplying
Notes: Kiran already has a Workday account at kiranshahi.can@gmail.com; application was submitted on March 5, 2026


## App 5 — Jerry.ai — Senior Associate, Business Operations — 2026-04-14
URL: https://jobs.ashbyhq.com/Jerry.ai/641bee2e-0a01-41dc-b18e-61e72897b8cd/application
Platform: Ashby ATS
Status: SUBMITTED ✓
Resume: Tailored via AutoApply (Resume.pdf uploaded automatically)
Notes: Ashby Yes/No buttons required coordinate clicks to register properly; Q5=Yes (authorized in Canada), Q6=No (no sponsorship), Q7=Yes (open to relocating)

## App 6 — Myticas Consulting — Business Analyst – Back Office (34868) — 2026-04-14
URL: https://apply.myticas.com/34868/Business%20Analyst%20%E2%80%93%20Back%20Office/?source=LinkedIn
Platform: Scout Genius ATS
Status: SUBMITTED ✓
Resume: Resume.pdf uploaded automatically via AutoApply
Notes: Scout Genius form — First/Last/Email/Phone auto-filled from resume parse; resume uploaded directly to file input; submitted via Submit Application button


## App 13 — Instacart — Strategic Finance Analyst, Product Finance — 2026-04-14
URL: https://www.instacart.careers/job?gh_jid=7809348
Platform: Greenhouse ATS (embedded cross-origin iframe on instacart.careers)
Status: SUBMITTED ✓ (partially manual)
Resume: Tailored via AutoApply (Resume - Instacart Careers - Strategic Finance Analyst Product Finance.pdf)
Notes: AutoApply filled all fields (Last Name, Email, Country, Phone, LinkedIn, "Worked at Instacart=No") via greenhouse.js running inside cross-origin boards.greenhouse.io iframe. Resume upload (Strategy 2–3) failed to register on Greenhouse's hidden file input — user uploaded PDF manually from Downloads and hit Submit. FIX NEEDED: greenhouse.js attemptResumeUpload Strategy 4 — force-inject into hidden file inputs (Greenhouse always hides native <input type="file"> behind custom drag-drop UI). Fix shipped in this session.


## App 8 — Wings4U — Business Automation Analyst — 2026-04-14
URL: https://hello.wings4u.com/hiring-business-automation-analyst
Platform: Google Forms (HubSpot landing page → Google Form)
Status: SUBMITTED ✓
Resume: Kiran_Shahi_BI.docx (from Google Drive "Kiran Resume" folder)
Notes: Google Form — filled Location (Vancouver BC Canada), Full Name, Email, LinkedIn URL, Role (Business Automation Analyst), English (Native), 5 yrs experience, Yes to part-time projects; CV uploaded from Google Drive


## App 7 — Alignerr — Business Performance Analyst (AI Training) — 2026-04-14
URL: https://www.alignerr.com/jobs/9439c95c-fdd0-4cb9-88e8-d0d8a5a9cad6?referral-source=linkedin-job
Platform: Alignerr (Labelbox)
Status: SKIPPED — sign-in via Google/LinkedIn OAuth required; no guest application path
Resume: Tailored via AutoApply ✓ (Resume - Alignerr - Business Performance Analyst.pdf)
Notes: Application wall requires Google or LinkedIn OAuth login before any form; manual sign-in needed


## App 4 — Societe Generale — Business Analyst on Market Data — 2026-04-14 12:32
URL: https://careers.societegenerale.com/en/job-offers/business-analyst-on-market-data-2600094B-en
Platform: SG Careers (external)
Status: SKIPPED — careers.societegenerale.com blocked by browser content restrictions
Notes: Cannot navigate to this domain


## App 9 — Chrome Technologies — Analyste d'affaires / Chargé de Projet — 2026-04-14
URL: https://www.chrometechnologies.com/postuler.php?id=mYWLk7fbLvnnJiTaBneYbivHgSZnjoN2n281Sq3oq6E
Platform: Custom PHP form
Status: PARTIALLY COMPLETE — needs user action ⚠
Resume: Tailored via AutoApply (Chrometechnologies · Postuler)
Notes: Form fully filled (Kiran Shahi, kiranshahi.can@gmail.com, 2369396746, tailored cover letter). BLOCKED by: (1) reCAPTCHA checkbox — must be solved by user; (2) CV file upload — must be attached manually. Resume PDF downloaded to Downloads folder. User clicks Envoyer to submit.


## App 11 — Insurity — Lead Business Analyst / Analyste Commercial Principal — 2026-04-14
URL: https://jobs.jobvite.com/insurity-review/job/oa4Bzfw8/apply
Platform: Jobvite ATS
Status: DUPLICATE — already applied previously
Notes: Jobvite redirected to /duplicateApplication — Kiran had previously submitted. Salary $77K–$150K CAD.


## App 12 — Guidewire Software — Business Architect (InnoCoDev) — 2026-04-14
URL: https://guidewire.wd5.myworkdayjobs.com/en-US/external/job/United-States---Remote/Business-Architect---Industry-Innovation---Co-Development-Group--InnoCoDev-_JR_14283/apply/applyManually
Platform: Workday
Status: PARTIALLY COMPLETE — Step 2 reached, needs manual work experience + resume upload ⚠
Resume: Tailored via AutoApply ✓
Notes: Step 1 crash (formField-source) fixed in this session — Step 2 now loads. Step 2 errors: Job Title, Company, From, To dates (work experience), and Resume upload. Root cause: parsedResume.workExperience=[] — the parse-resume API never extracted Kiran's work history from her resume. AutoApply filled Education (BPUT University, B.E. CS 2016) and selected degree. Workday resume upload programmatic injection also fails (no file chip appears). FIXES SHIPPED: (1) workday.js now scans ALL tailoredResumeMap entries as fallback for work experience; (2) false-positive resume upload detection removed. USER ACTION NEEDED: Re-upload resume in AutoApply Profile settings to fix parsedResume.workExperience, OR fill work experience + resume manually on this page. Workday account created for kiranshahi.can@gmail.com ✓.


## App 14 — Syntax — Senior Business Analyst SAP Commerce Cloud — 2026-04-14
URL: https://careers.syntax.com/job/Montreal-Senior-Business-Analyst-SAP-Commerce-Cloud-Queb-H3C-2M1/1308616300/
Platform: SAP SuccessFactors ATS (career4.successfactors.com)
Status: SKIPPED — SAP SuccessFactors login required; password entry not permitted
Resume: Tailored via AutoApply ✓ (Resume - Syntax - Senior Business Analyst - SAP Commerce Cloud.pdf)
Notes: JD captured 4848 chars, tailoring completed (~120s). ATS requires email+password or new account creation — cannot enter credentials on user's behalf. Email pre-filled as kiranshahi.can@gmail.com. User needs to sign in / create account at career4.successfactors.com then apply manually. Resume PDF is downloaded and ready.


## App 10 — Canadian Medical Association — FP&A Business Analyst (18-Month Term) — 2026-04-14
URL: https://recruiting.ultipro.ca/CAN5006CAMD/JobBoard/530dafdc-25d3-49da-b484-53b130441e25/OpportunityDetail?opportunityId=377927aa-5737-4cc5-88e1-590d18d08f8b
Platform: UltiPro ATS
Status: SKIPPED — UltiPro login required; password entry not permitted
Notes: Salary $85K–$106K CAD. Login wall requires email+password — cannot enter credentials on user's behalf. Manual sign-in needed at signin-ca.ultipro.ca

