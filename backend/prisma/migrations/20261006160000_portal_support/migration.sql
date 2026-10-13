CREATE TABLE "account_support_request" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(), "kind" TEXT NOT NULL, "name" TEXT NOT NULL,
 "username" TEXT, "contact" TEXT NOT NULL, "details" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending', "admin_note" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "resolved_at" TIMESTAMP(3), CONSTRAINT "account_support_request_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "account_support_request_status_created_at_idx" ON "account_support_request"("status", "created_at");
CREATE TABLE "notification_read" (
 "user_id" TEXT NOT NULL, "key" TEXT NOT NULL,
 "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "notification_read_pkey" PRIMARY KEY ("user_id", "key"),
 CONSTRAINT "notification_read_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
