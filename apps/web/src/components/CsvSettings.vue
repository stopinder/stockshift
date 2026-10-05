<script setup lang="ts">
import type { CsvSettings } from "../workflow";
const settings = defineModel<CsvSettings>({ required: true });
defineProps<{ side: string }>();
</script>
<template>
  <fieldset class="settings">
    <legend>CSV settings · {{ side }}</legend>
    <div class="field-grid">
      <label
        >SKU header<input v-model="settings.sku" required maxlength="200"
      /></label>
      <label
        >Cost header<input v-model="settings.price" required maxlength="200"
      /></label>
      <label
        >Description header <span class="muted">(optional)</span
        ><input v-model="settings.description" maxlength="200"
      /></label>
      <label
        >Delimiter<select v-model="settings.delimiter">
          <option value=",">Comma (,)</option>
          <option value=";">Semicolon (;)</option>
          <option :value="'\t'">Tab</option>
          <option value="|">Pipe (|)</option>
        </select></label
      >
      <label
        >Decimal separator<select v-model="settings.decimal">
          <option value=".">Dot (1.25)</option>
          <option value=",">Comma (1,25)</option>
        </select></label
      >
      <label
        >Thousands separator<select v-model="settings.thousands">
          <option value="">None</option>
          <option value=",">Comma</option>
          <option value=".">Dot</option>
          <option value=" ">Space</option>
        </select></label
      >
      <label
        >Currency<input
          v-model="settings.currency"
          required
          pattern="[A-Z]{3}"
          maxlength="3"
          placeholder="GBP"
      /></label>
      <label
        >Unit<input
          v-model="settings.unit"
          required
          maxlength="100"
          placeholder="each"
      /></label>
      <label
        >Pack quantity<input
          v-model="settings.pack"
          required
          maxlength="128"
          inputmode="decimal"
      /></label>
      <label
        >Price basis<select v-model="settings.priceBasis">
          <option value="unit">Per unit</option>
          <option value="pack">Per pack</option>
        </select></label
      >
      <label
        >Tax basis<select v-model="settings.taxBasis">
          <option value="net">Net</option>
          <option value="gross">Gross</option>
        </select></label
      >
      <label
        >Currency symbol <span class="muted">(optional)</span
        ><input v-model="settings.symbol" maxlength="10" placeholder="£"
      /></label>
    </div>
    <p class="hint">
      UTF-8 only. Header names are case-sensitive. Currency, unit, pack and
      price/tax basis apply to every row in this file.
    </p>
  </fieldset>
</template>
