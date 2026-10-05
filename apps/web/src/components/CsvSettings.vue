<script setup lang="ts">
import type { CsvSettings } from "../workflow";
const settings = defineModel<CsvSettings>({ required: true });
defineProps<{
  side: string;
  headers?: string[];
  xlsx?: boolean;
  pdf?: boolean;
}>();
</script>
<template>
  <fieldset class="settings">
    <legend>
      {{ pdf ? "PDF" : xlsx ? "XLSX" : "CSV" }} settings · {{ side }}
    </legend>
    <div class="field-grid">
      <label
        >SKU header<select
          v-if="xlsx"
          v-model="settings.sku"
          aria-label="SKU header"
          required
        >
          <option value="">Choose column</option>
          <option v-for="h in headers" :key="h" :value="h">
            {{ h }}
          </option></select
        ><input v-else v-model="settings.sku" required maxlength="200"
      /></label>
      <label
        >Cost header<select
          v-if="xlsx"
          v-model="settings.price"
          aria-label="Cost header"
          required
        >
          <option value="">Choose column</option>
          <option v-for="h in headers" :key="h" :value="h">
            {{ h }}
          </option></select
        ><input v-else v-model="settings.price" required maxlength="200"
      /></label>
      <label
        >Description header <span class="muted">(optional)</span
        ><select
          v-if="xlsx"
          v-model="settings.description"
          aria-label="Description header"
        >
          <option value="">Not mapped</option>
          <option v-for="h in headers" :key="h" :value="h">
            {{ h }}
          </option></select
        ><input v-else v-model="settings.description" maxlength="200"
      /></label>
      <label v-if="!xlsx"
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
          :required="!xlsx || !settings.currencyColumn"
          :disabled="xlsx && !!settings.currencyColumn"
          pattern="[A-Z]{3}"
          maxlength="3"
          placeholder="GBP"
      /></label>
      <label
        >Unit<input
          v-model="settings.unit"
          :required="!xlsx || !settings.unitColumn"
          :disabled="xlsx && !!settings.unitColumn"
          maxlength="100"
          placeholder="each"
      /></label>
      <label
        >Pack quantity<input
          v-model="settings.pack"
          :required="!xlsx || !settings.packColumn"
          :disabled="xlsx && !!settings.packColumn"
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
    <div v-if="xlsx" class="field-grid">
      <label
        v-for="field in ['currencyColumn', 'packColumn', 'unitColumn'] as const"
        :key="field"
        >{{
          field === "currencyColumn"
            ? "Currency column"
            : field === "packColumn"
              ? "Pack quantity column"
              : "Unit column"
        }}<select
          v-model="settings[field]"
          :aria-label="
            field === 'currencyColumn'
              ? 'Currency column'
              : field === 'packColumn'
                ? 'Pack quantity column'
                : 'Unit column'
          "
        >
          <option value="">Use file-wide default</option>
          <option v-for="h in headers" :key="h" :value="h">{{ h }}</option>
        </select></label
      >
    </div>
    <p class="hint">
      {{
        pdf
          ? "PDF text prices use the explicit decimal convention. Original evidence stays immutable; no fields are guessed."
          : xlsx
            ? "Stored numeric prices retain their exact decimal value; separators apply to text cells only. Unmapped commercial fields use the explicit file-wide defaults."
            : "UTF-8 only. Header names are case-sensitive. Currency, unit, pack and price/tax basis apply to every row in this file."
      }}
    </p>
  </fieldset>
</template>
