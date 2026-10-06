'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { APP_DISPLAY_NAME } from '@ima-jin/config';
import { ImajinFooter } from '@ima-jin/ui';
import { withBasePath } from '@/lib/base-path';

export default function CoffeePage() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // "Sign in with Imajin" (see src/components/ImajinAuthStatus.tsx).
  const signInUrl = `${process.env.NEXT_PUBLIC_IMAJIN_AUTH_URL ?? ''}/auth/authorize?app_id=${process.env.NEXT_PUBLIC_IMAJIN_APP_ID ?? ''}&scopes=profile:read`;

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch(withBasePath('/api/auth/session'));
        const user = res.ok ? await res.json() : null;
        setIsLoggedIn(Boolean(user));
      } catch { setIsLoggedIn(false); }
      finally { setCheckingAuth(false); }
    }
    checkAuth();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-6xl mb-4">☕</div>

          <h1 className="text-4xl font-bold mb-4">
            coffee.imajin.ai
          </h1>

          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
            Sovereign support pages for creators.
            <br />
            Accept tips. Keep the relationship. No middlemen.
          </p>

          {/* CTA */}
          <div className="flex justify-center mb-12">
            {!checkingAuth && (
              isLoggedIn ? (
                <Link href="/dashboard" className="inline-block px-8 py-4 bg-orange-500 text-white rounded-xl font-semibold text-lg hover:bg-orange-600 transition hover:shadow-lg">
                  Go to Dashboard →
                </Link>
              ) : (
                <a href={signInUrl} className="inline-block px-8 py-4 bg-orange-500 text-white rounded-xl font-semibold text-lg hover:bg-orange-600 transition hover:shadow-lg">
                  Sign In to Get Started
                </a>
              )
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8 text-left">
            <h2 className="text-2xl font-semibold mb-4 text-center">Why Coffee?</h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="text-2xl">☕</div>
                <div>
                  <h3 className="font-semibold">Your page, your terms</h3>
                  <p className="text-gray-500 text-sm">Set your own message, amounts, and story. No templates forcing your voice into a box.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">💸</div>
                <div>
                  <h3 className="font-semibold">No platform fees</h3>
                  <p className="text-gray-500 text-sm">Stripe processes the payment. You keep everything minus Stripe&apos;s standard fee. We take nothing.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🔗</div>
                <div>
                  <h3 className="font-semibold">Integrates with {APP_DISPLAY_NAME}</h3>
                  <p className="text-gray-500 text-sm">Connect your profile, links page, and events. One identity across the sovereign network.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🔒</div>
                <div>
                  <h3 className="font-semibold">You own the data</h3>
                  <p className="text-gray-500 text-sm">Supporter emails, transaction history — yours. No surveillance, no profiling.</p>
                </div>
              </div>
            </div>
          </div>

          <ImajinFooter className="mt-8" />
        </div>
      </div>
    </div>
  );
}
