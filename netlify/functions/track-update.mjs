// Scheduled: once an hour, compare stored outlooks with the FAA's record of
// what actually happened, and save the result for /api/track-record.
import { updateTrackRecord } from '../lib/store.mjs';

export default async () => {
  const r = await updateTrackRecord();
  console.log('GAPS track record', r ? `${r.hours} hours scored, ${r.roughHours} rough, AUC ${r.auc}, FAA days missing: ${r.faaDaysMissing.join(',') || 'none'}` : 'no outlook history yet');
};

export const config = { schedule: '23 * * * *' };
