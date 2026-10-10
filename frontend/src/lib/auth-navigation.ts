export type AuthLocation = { pathname: string; searchStr: string };

export type LoginDestination = {
  to: '/login';
  search: { redirect: string };
};

export function authenticationDestination(
  accessToken: string | null,
  mustChangePassword: boolean,
  location: AuthLocation,
): LoginDestination | { to: '/change-password' } | null {
  if (!accessToken) return { to: '/login', search: { redirect: location.pathname + location.searchStr } };
  return mustChangePassword && location.pathname !== '/change-password'
    ? { to: '/change-password' }
    : null;
}

export function loginDestinationAfterPasswordChange(redirectPath?: string): LoginDestination {
  const redirect = redirectPath?.startsWith('/') && !redirectPath.startsWith('//')
    ? redirectPath
    : '/dashboard';
  return { to: '/login', search: { redirect } };
}
