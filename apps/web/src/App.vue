<script setup lang="ts">
import { CONTRACT_VERSION } from '@stockshift/contracts'
</script>

<template>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="min-h-screen">
    <header class="border-b border-border bg-surface">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-5 sm:px-10">
        <span class="text-lg font-semibold tracking-tight text-brand">StockShift</span>
        <span class="text-sm text-muted">Application foundation</span>
      </div>
    </header>

    <main id="main" class="mx-auto max-w-5xl px-6 py-16 sm:px-10 sm:py-24" tabindex="-1">
      <p class="mb-5 text-sm font-medium text-brand">Supplier catalogue reconciliation</p>
      <h1 class="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">StockShift setup</h1>
      <p class="mt-6 max-w-xl text-lg leading-relaxed text-muted">
        The application foundation is in place. Catalogue uploads, comparisons, review,
        and exports will be added in subsequent implementation steps.
      </p>

      <section aria-labelledby="status-heading" class="mt-12 max-w-2xl border border-border bg-surface p-6 sm:p-8">
        <h2 id="status-heading" class="text-lg font-semibold">Current status</h2>
        <p class="mt-3 leading-relaxed text-muted">
          This is the setup page. No catalogue data is loaded and no processing services are connected.
        </p>
        <p class="mt-5 border-t border-border pt-5 text-sm text-muted">
          Next implementation step: deterministic CSV reconciliation.
        </p>
      </section>
    </main>

    <footer class="mx-auto max-w-5xl px-6 pb-8 text-sm text-muted sm:px-10">
      Foundation · Contract {{ CONTRACT_VERSION }}
    </footer>
  </div>
</template>
