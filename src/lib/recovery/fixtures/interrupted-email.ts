import { Resend } from "resend";

import { getDb } from "../../db/connection.ts";
import { createEmailService } from "../../services/email.ts";
import { runRecoveryJobs } from "../worker.ts";

const database = getDb();
const transport = createEmailService({
  resendClient: new Resend("re_local_fixture", { baseUrl: process.argv[3] }),
  resolveAddresses: async () => {
    throw new Error("worker re-resolved frozen addresses");
  },
});

try {
  await runRecoveryJobs({
    database,
    jobId: process.argv[2],
    emailService: {
      ...transport,
      async send(message, options) {
        const accepted = await transport.send(message, options);
        process.send?.({ accepted: accepted.messageId });
        // The parent kills the process between provider acceptance and DB acknowledgement.
        return await new Promise(() => {});
      },
    },
  });
} finally {
  await database.end();
}
