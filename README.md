# Base Starter Project

A clean, production-ready Next.js starter template with authentication and database integration.

## Features

- **Next.js 15** with App Router
  - Server Components and Server Actions
  - TypeScript support
  - Turbopack for fast development

- **Authentication**
  - Supabase Auth integration
  - Protected routes via middleware
  - Login and registration pages

- **Database**
  - Supabase integration ready
  - Database migrations included
  - Row Level Security (RLS) support

- **UI Components**
  - shadcn/ui components
  - Tailwind CSS styling
  - Dark mode support with next-themes
  - Responsive design

- **Testing**
  - Playwright for E2E testing
  - Route testing support
  - Husky git hooks (pre-commit, pre-push)

- **Developer Experience**
  - ESLint + Prettier for linting and formatting
  - TypeScript strict mode
  - Path aliases configured
  - OpenTelemetry instrumentation
  - Claude Code AI assistance (auto-configured via `pnpm install`)

## Getting Started

### Prerequisites

- Node.js 22 (specified in `.nvmrc`)
- pnpm

### Node Version

```bash
nvm use
```

<details>
<summary><strong>Auto-switch (Optional)</strong></summary>

To automatically switch Node versions when entering the project:

**Zsh (macOS / Linux)** - add to `~/.zshrc`:

```bash
autoload -U add-zsh-hook

load-nvmrc() {
  local nvmrc_path="$(nvm_find_nvmrc)"
  if [ -n "$nvmrc_path" ]; then
    local nvmrc_node_version=$(nvm version "$(cat "${nvmrc_path}")")
    if [ "$nvmrc_node_version" = "N/A" ]; then
      nvm install
    elif [ "$nvmrc_node_version" != "$(nvm version)" ]; then
      nvm use
    fi
  elif [ -n "$(PWD=$OLDPWD nvm_find_nvmrc)" ] && [ "$(nvm version)" != "$(nvm version default)" ]; then
    nvm use default
  fi
}

add-zsh-hook chpwd load-nvmrc
load-nvmrc
```

**Bash (Linux/WSL)** - add to `~/.bashrc`:

```bash
cdnvm() {
    command cd "$@" || return $?
    nvm_path="$(nvm_find_up .nvmrc | command tr -d '\n')"

    if [[ ! $nvm_path = *[^[:space:]]* ]]; then
        declare default_version
        default_version="$(nvm version default)"
        if [ "$default_version" = 'N/A' ]; then
            nvm alias default node
            default_version=$(nvm version default)
        fi
        if [ "$(nvm current)" != "${default_version}" ]; then
            nvm use default
        fi
    elif [[ -s "${nvm_path}/.nvmrc" && -r "${nvm_path}/.nvmrc" ]]; then
        declare nvm_version
        nvm_version=$(<"${nvm_path}"/.nvmrc)
        declare locally_resolved_nvm_version
        locally_resolved_nvm_version=$(nvm ls --no-colors "${nvm_version}" | command tail -1 | command tr -d '\->*' | command tr -d '[:space:]')
        if [ "${locally_resolved_nvm_version}" = 'N/A' ]; then
            nvm install "${nvm_version}";
        elif [ "$(nvm current)" != "${locally_resolved_nvm_version}" ]; then
            nvm use "${nvm_version}";
        fi
    fi
}

alias cd='cdnvm'
cdnvm "$PWD" || exit
```

Reload: `source ~/.zshrc` or `source ~/.bashrc`

</details>

### Environment Variables

Create a `.env.local` file in the root directory:

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Installation

```bash
# Install dependencies (also sets up Claude Code config automatically)
pnpm install

# Run development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see your application.

### Database Setup

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Run the migrations in `lib/db/migrations/` to set up your database schema
3. Update your `.env.local` with your Supabase credentials

## Project Structure

```
├── app/
│   ├── (auth)/          # Authentication pages and logic
│   ├── layout.tsx       # Root layout
│   ├── page.tsx         # Homepage
│   └── globals.css      # Global styles
├── components/
│   ├── ui/              # shadcn/ui components
│   └── ...              # Custom components
├── hooks/               # Custom React hooks
├── lib/
│   ├── auth/            # Auth actions, mutations, queries
│   ├── db/              # Supabase client and migrations
│   ├── constants.ts     # App constants
│   ├── errors.ts        # Error handling
│   ├── types.ts         # TypeScript types
│   └── utils.ts         # Utility functions
├── tests/               # Playwright tests (e2e/, routes/)
└── middleware.ts        # Auth middleware
```

## Available Scripts

- `pnpm dev` - Start development server with Turbopack
- `pnpm build` - Build for production
- `pnpm start` - Start production server
- `pnpm lint` - Run linting
- `pnpm lint:fix` - Fix lint errors
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check formatting without changes
- `pnpm typecheck` - TypeScript type checking
- `pnpm clean` - Remove node_modules, lock file, and .next
- `pnpm ui:add <component>` - Add shadcn/ui components
- `pnpm test` - Run Playwright tests
- `pnpm test:e2e` - Run E2E tests only
- `pnpm test:routes` - Run route tests only

## Git Hooks

This project uses [husky](https://typicode.github.io/husky/) to prevent broken code from being committed or pushed.

| Hook | Runs | Purpose |
|------|------|---------|
| **pre-commit** | `pnpm typecheck && pnpm lint` | Catches type errors and lint issues before commit |
| **pre-push** | `pnpm build` | Ensures the app builds successfully before pushing |

**To skip hooks temporarily** (use sparingly):
```bash
git commit --no-verify -m "WIP: work in progress"
git push --no-verify
```

## Claude Code

This project uses shared [Claude Code](https://claude.com/claude-code) configuration from [Lerai-repos/Claude-settings](https://github.com/Lerai-repos/Claude-settings).

The full config (AI rules, skills, plugins, permissions, spinner verbs) is installed automatically when you run `pnpm install`. After that, the config auto-syncs on every session start.

## Customization

### Adding Protected Routes

Edit `middleware.ts` to add your protected routes:

```typescript
function isProtectedRoute(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/dashboard');
}
```

### Styling

- Global styles: `app/globals.css`
- Tailwind config: `tailwind.config.ts`
- Theme configuration: Uses next-themes for dark mode

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [shadcn/ui Documentation](https://ui.shadcn.com)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)

## License

MIT
