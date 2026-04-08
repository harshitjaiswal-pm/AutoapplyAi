# AutoApply Issue Tracker

Started: 2026-04-08

This file tracks issues encountered during real job applications using AutoApply AI.
Each issue includes context, steps to reproduce, and a screenshot.

---

## Issue Log

## Issue #1 — 2026-04-08 12:27:16

- **ATS**: Workday
- **Step**: My Information
- **Type**: State Machine Stuck
- **URL**: `https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto%2C-ON%2C-CAN/Senior-Product-Manager--Tandem_26WD96166-1/apply`
- **Description**: Banner shows 'Waiting for page to finish loading...' indefinitely. Happens when navigating directly to a Workday apply URL instead of triggering via LinkedIn Easy Apply. pendingApplication is not set in chrome.storage so the state machine returns early and never advances.


---

## Issue #2 — 2026-04-08 12:37:56

- **ATS**: Workday
- **Step**: Any
- **Type**: Feature Request
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: When auto-fill fails on a field (e.g. textarea for work experience description, open-ended questions), user wants to point at the field via the AI Assistant sidebar and get a resume-tailored answer they can copy and paste manually. The 'Point at element' button exists but doesn't generate copy-ready content based on the user's resume. Need: point at field → AI generates tailored answer from resume → user copies and pastes.


---

## Issue #3 — 2026-04-08 12:38:53

- **ATS**: Workday
- **Step**: My Experience / Languages & Skills
- **Type**: UI Bug
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: Resume button in the 'YOUR TURN' banner becomes non-responsive (unclickable). Banner shows 'Review your application and click Submit when ready. AutoApply stops here — you stay in control of the final submit.' with Try Again, Skip Job, Resume buttons. Resume button appears highlighted but clicking it does nothing.


---

## Issue #4 — 2026-04-08 12:44:55

- **ATS**: Workday
- **Step**: Application Submitted
- **Type**: Feature Request
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: When a submission confirmation screen is detected (e.g. 'Application Submitted - Thank you for submitting your application!'), AutoApply should automatically record the application to a persistent applications dashboard/log. Schema should include: job_title, company, location, date_applied, job_url, job_description, resume_used (filename/version), ats_platform, status (Applied/In Review/etc). This becomes the user's personal application tracker — populated automatically without any manual entry.


---

## Issue #5 — 2026-04-08 12:45:38

- **ATS**: Greenhouse
- **Step**: Application Start
- **Type**: Application Failed
- **URL**: `https://boards.greenhouse.io/asana`
- **Description**: Job application for 'Senior Product Manager, AI Ecosystem Integrations' at Asana (Vancouver, BC Hybrid) marked as 'failed' in the AutoApply batch queue. No error detail shown to user — just a red 'failed' badge next to the job. Root cause unknown without console logs.


---

## Issue #6 — 2026-04-08 12:50:03

- **ATS**: Workday
- **Step**: Application Questions
- **Type**: Unfilled Field
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: Open-ended textarea 'In 3-4 sentences, describe how you use (or choose not to use) AI tools in your work.' left blank. AutoApply skipped this field — likely because it doesn't have logic to generate answers for free-text behavioral/open-ended questions. Field instructions say to include a concrete example. This is exactly the use case for Issue #2 (point at field → get resume-tailored answer to copy-paste).


---

## Issue #7 — 2026-04-08 12:52:51

- **ATS**: Greenhouse
- **Step**: Application Questions
- **Type**: Unfilled Field
- **URL**: `https://boards.greenhouse.io`
- **Description**: Multiple fields left blank: 'Current City & State' (dropdown, required), 'Current Company' (text, required), and the same open-ended AI tools textarea from Issue #6. LinkedIn URL was correctly filled (https://www.linkedin.com/in/harshitjaiswalschulic/). AutoApply is not filling required profile fields or the open-ended question on Greenhouse.


---

## Issue #8 — 2026-04-08 12:55:11

- **ATS**: Greenhouse
- **Step**: Diversity Survey
- **Type**: Unfilled Field
- **URL**: `https://boards.greenhouse.io/scribd`
- **Description**: Diversity survey fields not filled at Scribd (Greenhouse). Fields skipped: race/ethnicity checkboxes, gender identity radio, disability radio (Yes/No/Prefer not), Veteran status radio (Yes/No/Prefer not). These are optional fields but AutoApply should fill them based on user preferences stored in profile, or at minimum select 'I do not wish to disclose' for all to avoid leaving them blank.


---

## Issue #9 — 2026-04-08 12:56:08

- **ATS**: Workday
- **Step**: My Information
- **Type**: UI Bug
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: Resume download button appears while banner still shows 'Tailoring resume in background...' (Job 6/24, Autodesk - Product Manager Generative AI APIs). The button should only appear after tailoring is complete. Currently it shows during tailoring, meaning clicking it would download the previous/untailored resume. Button should be hidden or disabled with a 'Tailoring...' state until the tailored PDF is ready.


---

## Issue #10 — 2026-04-08 12:56:49

- **ATS**: Greenhouse
- **Step**: Work Experience
- **Type**: Unfilled Field
- **URL**: `https://boards.greenhouse.io`
- **Description**: Work Experience section entirely unfilled on Greenhouse. Job Title filled ('Senior Product Manager') and Company filled ('Amazon'), Location filled ('Seattle'), 'I currently work here' checkbox checked — but From date (MM/YYYY) is blank and Role Description textarea is empty. AutoApply is partially filling work experience but missing start date and role description.


---

## Issue #11 — 2026-04-08 12:58:34

- **ATS**: Workday
- **Step**: My Experience / Resume Upload
- **Type**: Resume Upload Timeout
- **URL**: `https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto%2C-ON%2C-CAN/Product-Manager--Generative-AI--APIs_26WD95497-1/apply/applyManually`
- **Description**: Red ISSUE banner: 'Resume upload timed out — please complete the application manually.' on Job 6/24 (Autodesk - Product Manager, Generative AI, APIs). The tailored resume was generated and downloaded (visible in download history: '1_Autodesk_Toronto_Senior_Product_Manager__Tandem_Resume.pdf') but AutoApply failed to upload it to the Workday Resume/CV file upload field before timing out. User left with empty resume upload and must attach manually.


---

## Issue #12 — 2026-04-08 13:00:01

- **ATS**: Workday
- **Step**: My Experience / Resume Upload
- **Type**: Resume Not Generated
- **URL**: `https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto%2C-ON%2C-CAN/Product-Manager--Generative-AI--APIs_26WD95497-1/apply/applyManually`
- **Description**: Correction to Issue #11: The tailored resume was NOT generated for Job 6/24 (Autodesk - Product Manager, Generative AI, APIs). No resume appears in download history for this job. The upload timeout banner appeared because the resume tailoring itself never completed or failed silently — AutoApply gave up before the PDF was ready. User had to proceed manually with no tailored resume.


---

## Issue #13 — 2026-04-08 13:00:01

- **ATS**: Workday
- **Step**: Application Questions 1 of 2
- **Type**: Banner Crash
- **URL**: `https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto%2C-ON%2C-CAN/Product-Manager--Generative-AI--APIs_26WD95497-1/apply/applyManually`
- **Description**: AutoApply banner completely disappeared (crashed) on 'Application Questions 1 of 2' step for Autodesk - Product Manager, Generative AI, APIs. Page shows 3 unfilled required dropdowns: 'Are you eligible to work in the country in which this position is located?', 'Will you now or in the future require sponsorship for employment visa status?', and 'I would like to be part of the Autodesk Talent Community'. No banner, no AutoApply controls visible — extension stopped responding mid-application.


---

## Issue #14 — 2026-04-08 13:01:25

- **ATS**: Greenhouse
- **Step**: Application Questions
- **Type**: Unfilled Field
- **URL**: `https://boards.greenhouse.io`
- **Description**: Entire application questions page left blank on Greenhouse. Unfilled fields: Country (dropdown, required), City/State/Province (text, required), Time zone (dropdown), Are you authorized to work in the country you reside? (set to 'Yes' — correct), Will you need sponsorship? (set to 'Yes' — may be wrong), Where did you first learn about this role? (dropdown, required, blank), Have you worked as a product manager in a software company? (dropdown, required, blank). All rich-text open-ended questions also blank: 'Briefly share why you will excel in this role', 'Please describe the main product(s) you work on and your role', 'Tell me about what you worked on last week', 'What tools do you use weekly to manage the product', 'How often do you launch major functionality and go-to-markets', 'What is driving you to look for a new role'. AutoApply has no logic to handle rich-text editors (contenteditable) or behavioral interview questions.


---

## Issue #15 — 2026-04-08 13:02:20

- **ATS**: Greenhouse
- **Step**: Application Questions
- **Type**: User Impact
- **URL**: `https://boards.greenhouse.io`
- **Description**: User had to skip the entire application due to multiple unfilled rich-text open-ended questions (Issue #14). Too time-consuming to answer 5+ behavioral paragraphs manually mid-batch. This is a critical drop-off point — AutoApply's inability to fill rich-text editors (contenteditable) and generate behavioral answers is causing users to abandon applications entirely.


---

## Issue #16 — 2026-04-08 13:05:50

- **ATS**: Greenhouse
- **Step**: My Information
- **Type**: Unfilled Field
- **URL**: `https://boards.greenhouse.io/scribd`
- **Description**: Phone field left blank (shows placeholder '1-415-555-1234...') on Greenhouse at Scribd. Email correctly filled (harshit.jaiswalamazon@gmail.com), Current City & State filled (Vancouver,BC,CA), Current Company filled (Amazon) — but Phone number not populated. AutoApply has phone in user profile but is not mapping it to Greenhouse phone fields.


---

## Issue #17 — 2026-04-08 13:07:42

- **ATS**: SmartRecruiters
- **Step**: Personal Information
- **Type**: Application Failed
- **URL**: `https://jobs.smartrecruiters.com/oneclick-ui/company/Xplor/publication/9a4fdf61-88be-47d1-a28b-702795f5da28`
- **Description**: AutoApply crashed entirely on SmartRecruiters (Xplor - SR Product Manager, Toronto). Extension did not fill any fields — City left blank, despite First name (Harshit), Last name (Jaiswal), Email, and Phone (778 793 7522) being filled. No AutoApply banner visible at all — extension did not activate on SmartRecruiters ATS. This ATS is likely unsupported.


---

## Issue #18 — 2026-04-08 13:07:42

- **ATS**: SmartRecruiters
- **Step**: My Experience / Resume Upload
- **Type**: UI Bug
- **URL**: `https://jobs.smartrecruiters.com/oneclick-ui/company/Xplor/publication/9a4fdf61-88be-47d1-a28b-702795f5da28`
- **Description**: Resume download button was disabled and then disappeared entirely during the SmartRecruiters (Xplor) application. User could not download the tailored resume to manually upload it. The download button should remain available and enabled at all times once the tailored PDF is ready — even if AutoApply crashes or the ATS is unsupported. Related to Issue #3 (Resume button non-responsive) and Issue #9 (button visible during tailoring).


---

## Issue #19 — 2026-04-08 13:09:06

- **ATS**: Workday
- **Step**: Application Start
- **Type**: UI Bug
- **URL**: `https://etsy.wd1.myworkdayjobs.com`
- **Description**: Banner shows 'Login required or page changed — sign in then click Retry' but there is no Retry button visible. User has no way to recover — cannot retry, skip, or resume. Banner appears on an Etsy Workday page. The Retry button is referenced in the message but missing from the DOM.


---

## Issue #20 — 2026-04-08 13:09:39

- **ATS**: Workday
- **Step**: My Experience / Resume Upload
- **Type**: Resume Not Generated
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: Tailored resume was not generated AND not available for download on an additional job (beyond Issue #12). User had no resume to provide — neither auto-uploaded by AutoApply nor available via the download button for manual upload. Two compounding failures: (1) tailoring failed silently, (2) download button unavailable. User submitted application with no resume attached.


---

## Issue #21 — 2026-04-08 13:10:50

- **ATS**: Workday
- **Step**: My Information
- **Type**: UI Bug
- **URL**: `https://jobs.ebayinc.com/us/en/apply?jobSeqNo=EBAEBAUSR0072810EXTERNALENUS&utm_source=linkedin&utm_medium=phenom-feeds&step=1&stepname=personalInformation`
- **Description**: eBay (Sr. Product Manager, Selling Tools R0072810) — same two issues as Etsy (Issue #19, #20): (1) Banner shows 'Login required or page changed — sign in then click Retry' but the Retry button IS visible top-right yet fields are all blank (First Name, Last Name, Address, City not filled — only Country=Canada auto-selected). (2) No tailored resume generated or available for download. AutoApply stalled at login check without filling any fields or providing resume.


---

## Issue #22 — 2026-04-08 13:11:09

- **ATS**: All
- **Step**: Job Review Modal
- **Type**: Feature Request
- **URL**: `https://www.linkedin.com`
- **Description**: No 'Previous Job' button in the job review modal (Job 14/24, Microsoft - Sr. Product Manager). User can only go forward (Apply / Skip) but cannot go back to review or change decision on a previous job. Need a back/previous navigation button so user can undo a skip or revisit a job they passed on.


---

## Issue #23 — 2026-04-08 13:12:06

- **ATS**: Unknown
- **Step**: Application Start
- **Type**: Wrong Tab Opened
- **URL**: `https://aha.io/company/careers/current-openings/sr-product-manager-remote`
- **Description**: While applying for Job 14/24 (Microsoft - Sr. Product Manager), AutoApply opened the Aha! careers page (aha.io/company/careers/current-openings/sr-product-manager-remote) instead of the Microsoft application. Banner shows 'Waiting for application form to load... Tailoring resume in background...' on the wrong company's page. AutoApply picked up the wrong URL — likely a job listing URL mismatch where the LinkedIn listing linked to Aha!'s own site instead of an ATS.


---

## Issue #24 — 2026-04-08 13:13:38

- **ATS**: Phenom
- **Step**: Application Start
- **Type**: Wrong Resume Downloaded
- **URL**: `https://jobs.ebayinc.com/us/en/job/EBAEBAUSR0073090EXTERNALENUS/Sr-Product-Manager-Seller-Experience`
- **Description**: Job 15/24 eBay (Sr. Product Manager - Seller Experience, Toronto, Phenom ATS). Two separate resume issues: (1) Microsoft's tailored resume downloaded when user clicked the eBay job — resume from previous job (Job 14, Microsoft) triggered on the wrong job transition. (2) The Microsoft application tab never actually opened — AutoApply moved on to eBay without completing Microsoft. (3) eBay resume downloaded later separately. Root cause: resume generation and download events are not correctly scoped to their job — a previous job's resume can fire during the next job's loading.


---

## Issue #25 — 2026-04-08 13:14:12

- **ATS**: Phenom
- **Step**: My Information / Resume Upload
- **Type**: Resume Upload Failed
- **URL**: `https://jobs.ebayinc.com/us/en/apply?jobSeqNo=EBAEBAUSR0073090EXTERNALENUS`
- **Description**: eBay (Sr. Product Manager - Seller Experience, Phenom ATS) shows browser alert 'File name is too long' when AutoApply attempts to upload the tailored resume. The generated resume filename (e.g. '15_eBay_Toronto_Sr._Product_Manager_–_Seller_Experience_Resume.pdf') exceeds the file name length limit accepted by the Phenom upload field. Resume filenames need to be shortened — likely a max of ~50 chars.


---

## Issue #26 — 2026-04-08 13:15:57

- **ATS**: Phenom
- **Step**: My Information
- **Type**: Wrong Data
- **URL**: `https://jobs.ebayinc.com/us/en/apply?jobSeqNo=EBAEBAUSR0073090EXTERNALENUS`
- **Description**: eBay (Sr. Product Manager - Seller Experience, Toronto, Phenom ATS) — tailored resume states 'Open to relocate to San Jose' instead of Toronto. The job is in Toronto (Onsite) so the resume should either reflect Toronto or remove the relocation line entirely. AutoApply is likely pulling a hardcoded or cached location from a previous application (possibly a US-based job) rather than using the target job's location.


---

## Issue #27 — 2026-04-08 13:16:36

- **ATS**: Phenom
- **Step**: My Information
- **Type**: Unfilled Field
- **URL**: `https://jobs.ebayinc.com/us/en/apply?jobSeqNo=EBAEBAUSR0073090EXTERNALENUS`
- **Description**: LinkedIn Profile field left blank on eBay (Phenom ATS). AutoApply fills LinkedIn URL correctly on Greenhouse (Issues #7, #16) but misses it on Phenom. The field label is 'LinkedIn Profile:' — likely a different selector than what AutoApply looks for.


---

## Issue #28 — 2026-04-08 13:18:28

- **ATS**: Workday
- **Step**: My Experience / Work Experience
- **Type**: Unfilled Field
- **URL**: `https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto%2C-ON%2C-CAN/Product-Manager_26WD96183-1/apply/applyManually`
- **Description**: Job 16/24 (Autodesk - Product Manager) — entire Work Experience section blank on Workday. Job Title, Company, Location all empty, 'I currently work here' unchecked, From/To dates empty, Role Description empty. Banner correctly shows 'YOUR TURN — Tailored resume ready, download it then upload it above' suggesting resume was generated but AutoApply gave up on filling the form fields. This is a recurring Workday work experience fill failure (see also Issues #10, previous sessions).


---

## Issue #29 — 2026-04-08 13:20:20

- **ATS**: Workday
- **Step**: My Experience / Resume Upload
- **Type**: UI Bug
- **URL**: `https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto%2C-ON%2C-CAN/Product-Manager_26WD96183-1/apply/applyManually`
- **Description**: Job 16/24 (Autodesk - Product Manager) — Banner says 'YOUR TURN: Tailored resume ready — download it, then upload it above' but user cannot find or download the resume. The timer is erratically jumping between 20s and 80s instead of counting in one direction, giving no clear signal of actual progress. User has no way to know: (1) is the resume actually ready? (2) where is it? (3) how long until it's ready? Banner message is misleading — it says 'ready' but resume is not accessible. Need clear status states: Tailoring... → Ready (with working download button) → Timed out.


---

## Issue #30 — 2026-04-08 13:21:09

- **ATS**: Workday
- **Step**: My Experience / Skills
- **Type**: UI Bug
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: Skills field loops repeatedly — AutoApply keeps typing skills one after another without stopping (e.g. 'Enterprise Adoption & Rollout' visible but keeps going in a loop). It should type a skill, select it from the dropdown, then move on — not continuously re-enter the same field. The skill entry loop never terminates, blocking progress to the next step.


---

## Issue #31 — 2026-04-08 13:21:59

- **ATS**: Workday
- **Step**: My Experience / Education
- **Type**: Unfilled Field
- **URL**: `https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/job/Toronto%2C-ON%2C-CAN/Product-Manager_26WD96183-1/apply/applyManually`
- **Description**: Job 16/24 (Autodesk - Product Manager) — Education section partially filled and broken. Education 2: School filled ('Shri Ram College of Commerce') but Degree dropdown stuck on 'Select One' with validation error, Field of Study blank, GPA blank, From/To years blank. Education 3: School blank with validation error, Degree stuck on 'Select One' with error. AutoApply created extra empty Education 3 entry but didn't fill it — leaving the form in an invalid state with validation errors blocking Next.


---

## Issue #32 — 2026-04-08 13:34:08

- **ATS**: Greenhouse
- **Step**: Work Experience
- **Type**: Unfilled Field
- **URL**: `https://boards.greenhouse.io`
- **Description**: Work Experience completely blank on Greenhouse — Job Title, Company, Location, From/To dates, Role Description all empty. This is the same as Issue #10 and #28. AutoApply is consistently failing to populate work experience on both Workday and Greenhouse from the user's resume. This is the single most critical fill failure — work experience is the core of any application.


---

## Issue #33 — 2026-04-08 13:35:03

- **ATS**: Workday
- **Step**: My Experience / Resume Upload
- **Type**: UI Bug
- **URL**: `https://autodesk.wd1.myworkdayjobs.com`
- **Description**: Job 19/24 (Autodesk - Product Manager, Infrastructure and Special Projects) — Banner says 'YOUR TURN: Waiting for your resume upload... AutoApply will continue automatically. 60s remaining — upload the tailored PDF from your Downloads folder.' but there is NO Resume download button in the banner. User is told to upload the tailored PDF but has no way to access it from the banner. The download button that should appear after tailoring is completely missing.


---

## Issue #34 — 2026-04-08 13:54:13

- **ATS**: All
- **Step**: AI Assistant Chatbot
- **Type**: Feature Request
- **URL**: `https://all`
- **Description**: The AI Assistant chatbot sidebar should have full context of: (1) the user's resume, (2) the current job description. This way when the user asks it questions like 'why am I a good fit?' or 'write me an answer for this question', it can give resume+job tailored responses. Currently the chatbot answers generically without knowing the resume or job context. This is in addition to auto-filling behavioral questions (Issue #6/#14) — for cases where the user wants to manually ask the chatbot to draft an answer.


---
