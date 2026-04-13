# AutoApply AI — Project Context

## What This Project Is

AutoApply AI is an AI-powered job application tool that tailors resumes for specific job postings. Users paste their resume and a job description, and the AI rewrites the resume to match the job requirements. It also generates cover letters and tracks applications.

**Live URL:** Deployed on Vercel (auto-deploys from main branch)
**Repo:** github.com/harshitjaiswal-pm/AutoapplyAi

---

## Team

- **Harshit Jaiswal** — Lead developer, built the core product. Works from his primary machine.
- **Kiran Shahi** — Technical BA / Product Manager, contributing to features and product direction. Works from Harshit's MacBook Air via her own user account.

---

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **AI:** Claude API (Anthropic) — used for resume parsing, job analysis, resume tailoring, cover letter generation, and chat
- **State Management:** Zustand (useAppStore.ts)
- **Auth:** NextAuth.js
- **Data:** Redis (for persistence)
- **Deployment:** Vercel (auto-deploy from GitHub main branch)

---

## Project Structure

```
src/
├── app/                        # Pages (file-based routing)
│   ├── page.tsx                # Home page (/)
│   ├── layout.tsx              # Shared layout with navbar
│   ├── tailor/page.tsx         # Resume tailoring workflow (/tailor)
│   ├── dashboard/page.tsx      # Application tracker (/dashboard)
│   ├── pipeline/page.tsx       # Application pipeline view (/pipeline)
│   ├── onboarding/             # New user setup
│   ├── auth/signin/            # Authentication
│   └── api/                    # Backend API routes
│       ├── parse-resume/       # Extract structured resume data
│       ├── analyze-job/        # Analyze job description
│       ├── tailor-resume/      # AI-generate tailored resume
│       ├── chat/               # AI chat for resume Q&A
│       ├── upload-resume/      # File upload handling
│       ├── answer-custom-question/  # Answer application questions
│       ├── user/resume/        # Get saved resume data
│       ├── export-resume/      # Export tailored resume
│       ├── export-cover-letter/# Export cover letter
│       └── export-jd/          # Export JD analysis
├── components/                 # Reusable UI
│   ├── ResumeUploader.tsx      # Resume input (text paste + PDF upload)
│   ├── JobAnalyzer.tsx         # Job description input + analysis
│   ├── TailorEngine.tsx        # Core tailoring UI + results
│   ├── NavLinks.tsx            # Navigation links
│   └── NavAuth.tsx             # Auth status in navbar
├── lib/                        # Utilities and backend logic
│   ├── prompts.ts              # AI prompt templates (IMPORTANT - core logic)
│   ├── auth.ts                 # NextAuth configuration
│   ├── redis.ts                # Redis connection
│   ├── resumeValidation.ts     # Resume validation logic
│   └── batchProcessor.ts       # Batch processing utility
├── store/
│   └── useAppStore.ts          # Zustand global state store
└── types/
    └── pdf-parse.d.ts          # Type definitions
```

---

## Coding Conventions

- Use TypeScript for all new files (.tsx for components, .ts for utilities)
- Use Tailwind CSS classes for styling (no separate CSS files)
- API routes go in src/app/api/[route-name]/route.ts
- Components go in src/components/
- Shared utilities go in src/lib/
- State management through Zustand store (src/store/useAppStore.ts)
- Keep AI prompts in src/lib/prompts.ts

---

## Git Workflow

### Branching Strategy
- **main** — Production branch. Vercel deploys from here. Never push directly.
- **kiran/[feature-name]** — Kiran's feature branches
- **harshit/[feature-name]** — Harshit's feature branches

### Daily Workflow
1. `git pull origin main` — Get latest changes
2. `git checkout -b kiran/my-feature` (or harshit/my-feature) — Create feature branch
3. Make changes, test with `npm run dev`
4. `git add .` then `git commit -m "clear description"`
5. `git push origin kiran/my-feature`
6. Create Pull Request on GitHub for review
7. After approval, merge into main (Vercel auto-deploys)

### Commit Message Style
Use clear, descriptive messages: "Add resume PDF upload support", "Fix dashboard loading state", "Update tailoring prompts for better output"

---

## Environment Variables

These must be set in .env.local (for local dev) and in Vercel dashboard (for production):

- `ANTHROPIC_API_KEY` — Claude API key
- `NEXTAUTH_SECRET` — Auth encryption key
- `REDIS_URL` — Redis connection string

**Never commit .env.local to Git.** It's in .gitignore.

---

## Product Roadmap

- [x] **Phase 1:** Resume tailoring engine (core product — DONE)
- [ ] **Phase 2:** Chrome extension for one-click job capture (IN PROGRESS)
- [ ] **Phase 3:** Auto-apply (form filling + submission)
- [ ] **Phase 4:** Supabase integration, PDF upload/export, analytics

---

## Current Focus Areas

*Update this section as priorities change:*

- Chrome extension development (Phase 2)
- Improving AI prompt quality for better tailoring results
- PDF upload and export support
- UI/UX improvements based on user testing

---

## Important Notes for AI Assistants

- The core AI logic lives in `src/lib/prompts.ts` — be careful modifying prompts as they directly affect output quality
- The Zustand store (`useAppStore.ts`) is the single source of truth for app state
- API routes handle all server-side logic — keep client components lightweight
- When adding new pages, follow Next.js App Router conventions (folder = route)
- Always test changes with `npm run dev` before committing
- The chrome-extension/ folder is a separate project within the repo
