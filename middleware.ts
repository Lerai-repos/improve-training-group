import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

function isProtectedRoute(pathname: string): boolean {
  // Add your protected routes here
  return pathname === '/' || pathname.startsWith('/dashboard');
}

function isAuthRoute(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/login') ||
    pathname === '/register' ||
    pathname.startsWith('/register')
  );
}

function buildRedirectUrl(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return url;
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const { pathname, search } = request.nextUrl;

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[]
      ) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({
          request: {
            headers: request.headers,
          },
        });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const { data, error } = await supabase.auth.getUser();
  const user = error ? null : data.user;

  if (isProtectedRoute(pathname) && !user) {
    const loginUrl = buildRedirectUrl(request, '/login');
    const returnTo = `${pathname}${search || ''}`;
    loginUrl.searchParams.set('redirect', returnTo);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthRoute(pathname) && user) {
    return NextResponse.redirect(buildRedirectUrl(request, '/'));
  }

  return response;
}

export const preferredRegion = ['fra1', 'lhr1', 'cdg1', 'arn1']

export const config = {
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
