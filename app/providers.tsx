'use client';

import type { ReactNode } from 'react';
import { ToastProvider } from '@ima-jin/ui';

/**
 * Client-side context providers. Coffee's tip form reports payment-method
 * hints through `useToast`, so the toast provider wraps the whole app.
 */
export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return <ToastProvider>{children}</ToastProvider>;
}
