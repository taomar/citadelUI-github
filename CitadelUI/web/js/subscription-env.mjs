/**
 * Browser-facing re-export.
 *
 * The `.env` subscription parser is shared with the server so a GitHub commit
 * and a local write apply exactly the same byte-preserving patch, so the single
 * implementation lives in `shared/`.
 */
export {
  SUBSCRIPTION_ENV_KEY,
  readSubscriptionIdFromText,
  validateAzdEnvironmentName,
  validateSubscriptionId,
  writeSubscriptionIdToText,
} from '../../shared/subscription-env.mjs';
