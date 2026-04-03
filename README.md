# AutoApply AI

AI-powered job application tool that tailors your resume for every job in seconds.

## Quick Start (5 minutes)

### Prerequisites

1. **Install Node.js** (v18+)
   - Go to https://nodejs.org
   - Download the LTS version
   - Run the installer, click "Next" through everything
   - Verify: open a terminal and run `node --version`

2. **Install Git**
   - Go to https://git-scm.com/download/win
   - Download and install with all defaults
   - Verify: run `git --version`

3. **Get a Claude API key**
   - Go to https://console.anthropic.com
   - Create an account
   - Go to "API Keys" and create a new key
   - Add $5 credit (this will last hundreds of resume tailorings)

### Setup

Open a terminal (Command Prompt or PowerShell) and run these commands:

```bash
# 1. Navigate to the project folder
cd "path\to\Ai autoapply\autoapply-ai"

# 2. Install dependencies (downloads all the libraries listed in package.json)
npm install

# 3. Add your API key
# Open .env.local in your editor and replace "your-api-key-here" with your actual key

# 4. Start the development server
npm run dev
```

Then open your browser to **http://localhost:3000**

### How to Use

1. Click "Tailor Resume" in the navigation
2. **Step 1**: Paste your resume text and click "Parse Resume"
3. **Step 2**: Paste a job description and click "Analyze Job"
4. **Step 3**: Click "Tailor My Resume" — AI generates a custom version
5. Copy the tailored resume and cover letter
6. Check the Dashboard to track your applications

## Project Structure

```
autoapply-ai/
├── src/
│   ├── app/                    # Pages (file = URL route)
│   │   ├── layout.tsx          # Shared layout (navbar)
│   │   ├── page.tsx            # Home page (/)
│   │   ├── tailor/page.tsx     # Tailoring workflow (/tailor)
│   │   ├── dashboard/page.tsx  # Application tracker (/dashboard)
│   │   └── api/                # Backend API routes
│   │       ├── parse-resume/   # POST /api/parse-resume
│   │       ├── analyze-job/    # POST /api/analyze-job
│   │       └── tailor-resume/  # POST /api/tailor-resume
│   ├── components/             # Reusable UI components
│   │   ├── ResumeUploader.tsx  # Resume paste/upload
│   │   ├── JobAnalyzer.tsx     # Job description input
│   │   └── TailorEngine.tsx    # Tailoring + results display
│   ├── lib/
│   │   └── prompts.ts          # AI prompt templates
│   └── store/
│       └── useAppStore.ts      # Global state (Zustand)
├── .env.local                  # API keys (never commit!)
├── .gitignore                  # Files to exclude from Git
├── package.json                # Dependencies and scripts
├── tailwind.config.ts          # Styling configuration
└── tsconfig.json               # TypeScript configuration
```

## Tech Stack

- **Next.js 14** — React framework with built-in API routes
- **TypeScript** — Type-safe JavaScript
- **Tailwind CSS** — Utility-first CSS framework
- **Claude API** — AI for resume parsing and tailoring
- **Zustand** — Lightweight state management

## Roadmap

- [x] Phase 1: Resume tailoring engine (this!)
- [ ] Phase 2: Chrome extension for one-click job capture
- [ ] Phase 3: Auto-apply (form filling + submission)
- [ ] Supabase integration for data persistence
- [ ] PDF upload support
- [ ] PDF export of tailored resumes

## Deploying to Vercel (Make it Live)

1. Push your code to GitHub
2. Go to https://vercel.com and sign in with GitHub
3. Click "New Project" → import your repo
4. Add your ANTHROPIC_API_KEY as an environment variable
5. Click Deploy — your app is live!
