import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import uploads from "./api/uploads.ts";
import exportHandler from "./server/export.ts";
import pdfHandler from "./api/pdf.ts";
import workbookHandler from "./api/workbook.ts";
import billingHandler from "./api/billing.ts";
import stripeWebhookHandler from "./api/stripe-webhook.ts";
import { validateDeploymentConfig } from "./server/supabase-upload-gateway.ts";

export default defineConfig(({ command }) => {
  if (command === "build" && process.env.VERCEL === "1")
    validateDeploymentConfig(process.env);
  return {
    plugins: [
      vue(),
      tailwindcss(),
      {
        name: "local-stockshift-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url?.split("?")[0];
            if (path === "/api/stripe-webhook") {
              await stripeWebhookHandler(req, res);
              return;
            }
            if (path === "/api/export") {
              await exportHandler(req, res);
              return;
            }
            if (
              path !== "/api/uploads" &&
              path !== "/api/workbook" &&
              path !== "/api/pdf" &&
              path !== "/api/billing"
            ) {
              next();
              return;
            }
            try {
              let body = "";
              for await (const chunk of req) {
                body += chunk.toString();
                if (body.length > 32768) {
                  res.statusCode = 413;
                  res.end("{}");
                  return;
                }
              }
              Object.assign(req, { body: body ? JSON.parse(body) : null });
              await (
                path === "/api/billing"
                  ? billingHandler
                  : path === "/api/pdf"
                    ? pdfHandler
                    : path === "/api/workbook"
                      ? workbookHandler
                      : uploads
              )(req, res);
            } catch {
              res.statusCode = 400;
              res.end('{"error":"Invalid JSON request"}');
            }
          });
        },
      },
    ],
    server: {
      port: process.env.STOCKSHIFT_TEST_DAEMON === "1" ? 5183 : 5173,
      strictPort: true,
    },
    preview: { port: 4173, strictPort: true },
  };
});
