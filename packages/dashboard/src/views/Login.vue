<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  fetchAuthConfig,
  forgotPassword,
  passwordLogin,
  signup,
  verifyEmail,
  verifyOAuthEmail,
} from '../api';
import EyeIcon from '../components/icons/EyeIcon.vue';
import EyeSlashIcon from '../components/icons/EyeSlashIcon.vue';
import LastUsedBadge from '../components/LastUsedBadge.vue';
import LoginShowcase from '../components/LoginShowcase.vue';
import SocialLoginButtons from '../components/SocialLoginButtons.vue';
import { socialProviderButtons } from '../composables/socialProviders';
import {
  readLastAuthMethod,
  writeLastAuthMethod,
  type LastAuthMethod,
} from '../composables/useLastAuthMethod';
import { useLoginFlow } from '../composables/useLoginFlow';
import { completePostAuth } from '../post-auth';
import Button from '../components/ui/Button.vue';
import type { SocialProviderId } from '../types/api';

const router = useRouter();
const {
  mode,
  config,
  email,
  password,
  code,
  error,
  submitting,
  loadConfig,
  showSignin,
  showSignup,
  showForgot,
  beginOAuthVerification,
  restartAuthentication,
  submitCredentials,
  submitVerification,
  submitForgotPassword,
} = useLoginFlow({
  fetchAuthConfig,
  passwordLogin,
  signup,
  verifyEmail,
  verifyOAuthEmail,
  forgotPassword,
  completeAuthentication: () => completePostAuth(router),
  navigate: (target) => { window.location.href = target; },
});

const socialButtons = computed(() => socialProviderButtons(config.value?.social_providers ?? []));
// Read during setup, not onMounted: localStorage is synchronous, and deferring
// it makes the badge pop in one tick after first paint.
const lastAuthMethod = ref<LastAuthMethod | null>(readLastAuthMethod());
const showPassword = ref(false);

function recordAuthMethod(method: LastAuthMethod): void {
  writeLastAuthMethod(method);
  lastAuthMethod.value = method;
}

function handleSocialSelect(id: SocialProviderId): void {
  recordAuthMethod(id);
}

function handleCredentialsSubmit(): void {
  recordAuthMethod('password');
  void submitCredentials();
}

function redirectSignIn(): void {
  recordAuthMethod('redirect');
  window.location.href = '/auth/login';
}

// Re-mask AND discard the value. The reveal control makes a retained password
// readable by whoever uses the browser next, so leaving one behind across a
// signup/forgot detour is a disclosure, not just stale state.
watch(mode, () => {
  showPassword.value = false;
  password.value = '';
});

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('challenge') === 'email') {
    beginOAuthVerification();
    return;
  }
  void loadConfig();
});
</script>

<template>
  <div class="min-h-screen bg-background lg:grid lg:grid-cols-2">
    <div class="flex min-h-screen items-center justify-center px-4 py-8">
      <div class="max-w-sm w-full bg-surface rounded-lg border border-border p-8 lg:border-0 lg:bg-transparent lg:p-0">
        <div class="mx-auto mb-6 h-10 w-10 rounded-lg bg-accent/10 flex items-center justify-center">
          <svg class="h-5 w-5 text-accent" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
        </div>

        <div v-if="mode === 'loading' || mode === 'success'" class="text-center">
          <div class="animate-spin h-8 w-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-4"></div>
          <p class="text-sm text-muted">
            {{ mode === 'success' ? 'Completing sign in...' : 'Loading sign in...' }}
          </p>
        </div>

        <div v-else-if="mode === 'config-error'" class="text-center">
          <h1 class="text-xl font-semibold text-text mb-2">Sign in unavailable</h1>
          <p class="text-sm text-danger mb-6" v-text="error"></p>
          <Button variant="primary" class="w-full py-3 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background" @click="loadConfig">
            Try again
          </Button>
        </div>

        <div v-else-if="mode === 'redirect'" class="text-center">
          <h1 class="text-xl font-semibold text-text mb-1">Sign in to Opslane</h1>
          <p class="text-sm text-muted mb-8">
            Continue with your configured identity provider.
          </p>

          <SocialLoginButtons
            :buttons="socialButtons"
            divider-label="or"
            :last-used="lastAuthMethod"
            @select="handleSocialSelect"
          />

          <button
            type="button"
            data-testid="idp-redirect-button"
            @click="redirectSignIn"
            class="w-full flex items-center justify-start gap-3 rounded-md bg-surface-subtle border border-border px-4 py-3 text-sm font-medium text-text hover:bg-border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background transition-colors"
          >
            <svg data-testid="idp-lock-icon" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
            Continue to sign in
            <LastUsedBadge v-if="lastAuthMethod === 'redirect'" />
          </button>
        </div>

        <div v-else-if="mode === 'verify-code'">
          <h1 class="text-xl font-semibold text-text text-center mb-1">Verify your email</h1>
          <p class="text-sm text-muted text-center mb-6">
            Enter the 6-digit code sent to
            <span v-if="email" class="text-text" v-text="email"></span>
            <template v-else>your email address</template>.
          </p>
          <form class="space-y-4" @submit.prevent="submitVerification">
            <div>
              <label for="verification-code" class="block text-sm font-medium text-text mb-1.5">Verification code</label>
              <input
                id="verification-code"
                v-model="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                required
                autofocus
                class="w-full rounded-md border border-border bg-surface-subtle px-3 py-2.5 text-text placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="123456"
              />
            </div>
            <p v-if="error" class="text-sm text-danger" role="alert" v-text="error"></p>
            <Button variant="primary" class="w-full py-3 hover:opacity-90 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background" type="submit" :disabled="submitting">
              {{ submitting ? 'Verifying...' : 'Verify email' }}
            </Button>
          </form>
          <p class="mt-5 text-center text-sm text-muted">
            Lost the code?
            <button type="button" class="text-accent hover:underline" @click="restartAuthentication">
              Sign in again to get a new one.
            </button>
          </p>
        </div>

        <div v-else-if="mode === 'forgot'">
          <h1 class="text-xl font-semibold text-text text-center mb-1">Reset your password</h1>
          <p class="text-sm text-muted text-center mb-6">
            We’ll email you a link to choose a new password.
          </p>
          <form class="space-y-4" @submit.prevent="submitForgotPassword">
            <div>
              <label for="reset-email" class="block text-sm font-medium text-text mb-1.5">Email</label>
              <input
                id="reset-email"
                v-model="email"
                type="email"
                autocomplete="email"
                required
                autofocus
                class="w-full rounded-md border border-border bg-surface-subtle px-3 py-2.5 text-text placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="you@example.com"
              />
            </div>
            <p v-if="error" class="text-sm text-danger" role="alert" v-text="error"></p>
            <Button variant="primary" class="w-full py-3 hover:opacity-90 disabled:opacity-60" type="submit" :disabled="submitting">
              {{ submitting ? 'Sending...' : 'Send reset link' }}
            </Button>
          </form>
          <button type="button" class="mt-5 w-full text-sm text-accent hover:underline" @click="showSignin">
            Back to sign in
          </button>
        </div>

        <div v-else-if="mode === 'forgot-sent'" class="text-center">
          <h1 class="text-xl font-semibold text-text mb-2">Check your email</h1>
          <p class="text-sm text-muted mb-6">
            If an account exists for <span class="text-text" v-text="email"></span>, a password reset link is on its way.
          </p>
          <button type="button" class="text-sm text-accent hover:underline" @click="showSignin">
            Back to sign in
          </button>
        </div>

        <div v-else>
          <h1 class="text-xl font-semibold text-text text-center mb-1">
            {{ mode === 'signup' ? 'Create your Opslane account' : 'Sign in to Opslane' }}
          </h1>
          <p class="text-sm text-muted text-center mb-6">
            {{ mode === 'signup' ? 'Start resolving production errors.' : 'Welcome back.' }}
          </p>

          <div v-if="config?.supports_signup" class="mb-6 grid grid-cols-2 rounded-md bg-surface-subtle p-1" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              :aria-selected="mode === 'signin'"
              class="rounded px-3 py-2 text-sm font-medium transition-colors"
              :class="mode === 'signin' ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'"
              @click="showSignin"
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="mode === 'signup'"
              class="rounded px-3 py-2 text-sm font-medium transition-colors"
              :class="mode === 'signup' ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'"
              @click="showSignup"
            >
              Sign up
            </button>
          </div>

          <SocialLoginButtons
            :buttons="socialButtons"
            divider-label="or continue with email"
            :last-used="lastAuthMethod"
            @select="handleSocialSelect"
          />

          <form class="space-y-4" @submit.prevent="handleCredentialsSubmit">
            <div>
              <label for="auth-email" class="block text-sm font-medium text-text mb-1.5">Email</label>
              <input
                id="auth-email"
                v-model="email"
                type="email"
                autocomplete="email"
                required
                autofocus
                class="w-full rounded-md border border-border bg-surface-subtle px-3 py-2.5 text-text placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <div class="mb-1.5 flex items-center justify-between">
                <label for="auth-password" class="block text-sm font-medium text-text">Password</label>
                <button
                  v-if="mode === 'signin' && config?.supports_reset"
                  type="button"
                  class="text-xs text-accent hover:underline"
                  @click="showForgot"
                >
                  Forgot password?
                </button>
              </div>
              <div class="relative">
                <input
                  id="auth-password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
                  required
                  class="w-full rounded-md border border-border bg-surface-subtle px-3 py-2.5 pr-10 text-text placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  data-testid="password-toggle"
                  aria-label="Show password"
                  :aria-pressed="showPassword"
                  class="absolute inset-y-0 right-0 flex items-center px-3 text-muted hover:text-text rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  @click="showPassword = !showPassword"
                >
                  <EyeSlashIcon v-if="showPassword" />
                  <EyeIcon v-else />
                </button>
              </div>
            </div>
            <p v-if="error" class="text-sm text-danger" role="alert" v-text="error"></p>
            <Button variant="primary" class="w-full py-3 hover:opacity-90 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background" type="submit" :disabled="submitting">
              {{ submitting ? 'Please wait...' : mode === 'signup' ? 'Create account' : 'Sign in' }}
            </Button>
          </form>
        </div>
      </div>
    </div>
    <LoginShowcase />
  </div>
</template>
