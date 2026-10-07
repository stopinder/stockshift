<script setup lang="ts">
defineProps<{ registrationEnabled: boolean }>();
const examples = [
  {
    sku: "00123",
    name: "Brass compression fitting",
    old: "£6.40",
    next: "£7.10",
    change: "+10.94%",
    status: "Price increase",
    kind: "up",
  },
  {
    sku: "00042",
    name: "Galvanised fixing bracket",
    old: "£5.25",
    next: "£4.80",
    change: "−8.57%",
    status: "Price decrease",
    kind: "down",
  },
  {
    sku: "B-108",
    name: "Heavy-duty cable clips",
    old: "—",
    next: "£3.75",
    change: "—",
    status: "New product",
    kind: "new",
  },
  {
    sku: "C-206",
    name: "M8 threaded rod",
    old: "£2.90",
    next: "—",
    change: "—",
    status: "Absent from new file",
    kind: "absent",
  },
];
function section(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}
</script>
<template>
  <div class="landing">
    <nav class="landing-nav" aria-label="On this page">
      <button class="quiet" @click="section('how-it-works')">
        How it works
      </button>
      <button class="quiet" @click="section('launch-plan')">Launch plan</button>
      <a class="button primary" href="#/signup"
        >{{ registrationEnabled ? "Create an account" : "Launch details" }}
        <span aria-hidden="true">↗</span></a
      >
    </nav>
    <section class="landing-hero">
      <div class="hero-copy">
        <p class="eyebrow">SUPPLIER PRICE LISTS. CLEARLY COMPARED.</p>
        <h1>
          A new price list.<br />A clear picture<br /><em>of what changed.</em>
        </h1>
        <p class="hero-description">
          Compare your current catalogue with your supplier’s latest CSV. See
          price increases, new products and changes that need a closer look—then
          export the reviewed updates.
        </p>
        <div class="hero-actions">
          <a class="button primary" href="#/signup"
            >{{ registrationEnabled ? "Get started" : "View launch details" }}
            <span aria-hidden="true">→</span></a
          ><button class="quiet" @click="section('example-results')">
            See an example ↓
          </button>
        </div>
        <p class="hero-note">
          CSV launch edition · Private workspaces · Review before export
        </p>
      </div>
      <div id="example-results" class="product-preview">
        <div class="preview-heading">
          <span class="preview-icon" aria-hidden="true">↔</span>
          <div>
            <strong>October supplier update</strong>
            <p>Current catalogue → New price list</p>
          </div>
          <span class="example-label">Illustrative example</span>
        </div>
        <div class="preview-summary">
          <div><strong>4</strong><span>Products</span></div>
          <div><strong>1</strong><span>Increase</span></div>
          <div><strong>1</strong><span>Decrease</span></div>
          <div><strong>1</strong><span>New</span></div>
        </div>
        <div class="preview-table-wrap">
          <table class="preview-table">
            <caption class="sr-only">
              Illustrative product comparison, not customer results
            </caption>
            <thead>
              <tr>
                <th>Product / SKU</th>
                <th>Current</th>
                <th>New</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in examples" :key="item.sku">
                <td>
                  <strong>{{ item.name }}</strong
                  ><span>{{ item.sku }} · {{ item.status }}</span>
                </td>
                <td>{{ item.old }}</td>
                <td>{{ item.next }}</td>
                <td :class="item.kind">{{ item.change }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="preview-footer">
          <span>Source rows retained. Exact prices preserved.</span
          ><span class="export-example">Reviewed changes.csv ↗</span>
        </div>
      </div>
    </section>
    <div class="promise-strip">
      <span>Match by product code</span><span>See exact price changes</span
      ><span>Resolve uncertain records</span
      ><span>Export reviewed updates</span>
    </div>
    <section id="how-it-works" class="landing-section">
      <p class="eyebrow">FROM TWO FILES TO ONE CLEAR DECISION</p>
      <h2>
        Your next supplier update,<br />without the spreadsheet detective work.
      </h2>
      <div class="steps-grid">
        <article>
          <span class="step-number">01</span>
          <h3>Upload your two CSVs</h3>
          <p>
            Add your current catalogue and the latest supplier file. Choose the
            code, description and price columns, plus currency and units.
          </p>
        </article>
        <article>
          <span class="step-number">02</span>
          <h3>Review what changed</h3>
          <p>
            Filter increases, decreases, new and absent products. Missing or
            duplicate codes are flagged for a decision.
          </p>
        </article>
        <article>
          <span class="step-number">03</span>
          <h3>Take the updates with you</h3>
          <p>
            Resolve flagged records and download changed products as a CSV. Your
            stock system stays under your control.
          </p>
        </article>
      </div>
    </section>
    <section class="trust-section">
      <div>
        <p class="eyebrow">BUILT FOR COMMERCIAL DETAILS</p>
        <h2>The small details<br />are the important ones.</h2>
        <p>
          Leading zeros, decimal precision and price units matter. StockShift
          keeps the source identifiers and lets you inspect the settings behind
          each comparison.
        </p>
      </div>
      <ul>
        <li>
          <strong>Product codes stay product codes.</strong
          ><span>00123 stays 00123, including in your export.</span>
        </li>
        <li>
          <strong>Uncertain records need your decision.</strong
          ><span
            >Flagged items stay out of the update file until resolved.</span
          >
        </li>
        <li>
          <strong>Your source stays traceable.</strong
          ><span>Return to the file and row behind a result.</span>
        </li>
        <li>
          <strong>No automatic stock-system writes.</strong
          ><span>You review the changes and choose what to import.</span>
        </li>
      </ul>
    </section>
    <section id="launch-plan" class="landing-section launch-section">
      <div>
        <p class="eyebrow">A FOCUSED FIRST RELEASE</p>
        <h2>Start with the files<br />you already export.</h2>
        <p>
          CSV catalogue comparisons are available in the current release. Excel
          workbooks and PDF extraction are not yet available in the hosted app.
        </p>
      </div>
      <div class="launch-card">
        <span class="example-label">CSV launch edition</span>
        <h3>One workspace. A clear workflow.</h3>
        <ul>
          <li>Two CSV files per comparison, up to 10 MiB each</li>
          <li>Price changes, additions and absent products</li>
          <li>Saved results and mandatory review for flagged records</li>
          <li>Changed-products CSV export</li>
        </ul>
        <p>
          Paid subscriptions are being prepared. No payment is collected here.
        </p>
        <a class="button primary" href="#/signup">{{
          registrationEnabled
            ? "Create your account →"
            : "Account registration opens soon"
        }}</a>
      </div>
    </section>
    <section class="landing-section faq-section">
      <p class="eyebrow">BEFORE YOU START</p>
      <h2>A few practical answers.</h2>
      <details>
        <summary>What columns do my files need?</summary>
        <p>
          A product code (SKU) and purchase-price column. A description column
          is optional. You choose the column mapping and specify currency, unit,
          pack quantity, tax and price basis.
        </p>
      </details>
      <details>
        <summary>Does an absent product mean it is discontinued?</summary>
        <p>
          No. It means the product was not found in the new file you supplied.
          An incomplete supplier file cannot establish discontinuation.
        </p>
      </details>
      <details>
        <summary>Can I upload Excel or PDFs?</summary>
        <p>
          This hosted release supports CSV only. Export an Excel worksheet as
          CSV before uploading. PDF and OCR support are not included in this
          release.
        </p>
      </details>
      <details>
        <summary>Will this update my inventory automatically?</summary>
        <p>
          No. StockShift creates a reviewed CSV for you to check and import. It
          does not connect to or write into your inventory system.
        </p>
      </details>
    </section>
    <section class="landing-close">
      <p class="eyebrow">LESS SEARCHING. CLEARER UPDATES.</p>
      <h2>Know what changed<br />before you change your prices.</h2>
      <a class="button primary" href="#/signup">{{
        registrationEnabled
          ? "Get started with StockShift →"
          : "View account availability →"
      }}</a>
    </section>
  </div>
</template>
