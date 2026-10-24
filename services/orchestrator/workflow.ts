import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Analysis, Evidence, ReportResult, RunResult, Snapshot } from '../../packages/contracts/schemas.ts';
import { approvalSignature, buildPlan, cleanupWaitExpired, constants, hash, terminal } from '../../packages/contracts/domain.ts';
import { acknowledgeFinalizingCancellation, locked, related, transaction, transition, UNRESOLVED_RUN, type Investigation } from '../../packages/workflow/store.ts';
import type { Config } from '../../packages/workflow/config.ts';
import { service } from '../../packages/workflow/http.ts';

export async function investigate(pool: Pool, settings: Config, id: string): Promise<void> {
  // Session-level guard prevents two workers submitting the same investigation.
  // API row locks are separate, so cancellation can still be requested promptly.
  const guard = await pool.connect();
  try {
    const lock = await guard.query('SELECT pg_try_advisory_lock(hashtextextended($1,1)) AS acquired', [id]);
    if (!lock.rows[0].acquired) { guard.release(); return; }
  } catch (error) { guard.release(); throw error; }
  try {
    for (let step = 0; step < 8; step++) {
      const inv = (await pool.query('SELECT * FROM bugout.investigations WHERE id=$1', [id])).rows[0] as Investigation | undefined;
      if (!inv || terminal.has(inv.status)) return;
      const details = await related(pool, id);
      const currentRun = details.runs.find(r => !r.evidence && r.runner_status !== 'cancelled_before_start');

      if ((inv.cancel_requested_at || inv.deadline_at <= new Date()) && inv.status !== 'finalizing') {
        if (currentRun) {
          const state = RunResult.parse(await service(settings.runnerUrl, settings.runnerToken, `/runs/${currentRun.id}/cancel`, {}));
          if (state.run_id !== currentRun.id) throw new Error('Cancellation acknowledged a different run');
          if (state.state !== 'finished') {
            if (cleanupWaitExpired(inv.cancel_requested_at, inv.deadline_at)) {
              await transaction(pool, async client => {
                const fresh = await locked(client, id);
                if (terminal.has(fresh.status)) return;
                await client.query("UPDATE bugout.investigations SET cleanup_status='unconfirmed',incomplete_reason='Runner did not acknowledge cleanup within the cancellation budget' WHERE id=$1", [id]);
                await transition(client, fresh, 'failed', 'Cleanup acknowledgement deadline exceeded');
              });
            }
            return;
          }
          // An absent run is durably tombstoned before acknowledgement, so a
          // delayed submission cannot execute after cancellation completes.
          if (state.evidence) await saveEvidence(pool, inv, currentRun.id, state.evidence);
          else await pool.query("UPDATE bugout.execution_runs SET runner_status='cancelled_before_start',updated_at=now() WHERE id=$1 AND evidence IS NULL", [currentRun.id]);
        }
        await transaction(pool, async client => {
          const fresh = await locked(client, id);
          if (fresh.status === 'failed') return;
          await client.query("UPDATE bugout.follow_up_rounds SET status='expired' WHERE investigation_id=$1 AND status='open'", [id]);
          await client.query("UPDATE bugout.investigations SET cleanup_status='completed',incomplete_reason=COALESCE(incomplete_reason,'Investigation lifetime expired') WHERE id=$1", [id]);
          await transition(client, fresh, 'finalizing', 'Cancellation or total deadline; cleanup acknowledged');
        });
        continue;
      }
      if (inv.status === 'queued') {
        await transaction(pool, async client => { const fresh = await locked(client, id); await transition(client, fresh, 'analyzing', 'Beginning deterministic analysis'); });
        continue;
      }
      if (inv.status === 'analyzing') {
        const analysis = Analysis.parse(await service(settings.engineUrl, settings.engineToken, '/analyze', { intake: inv.intake, rounds: details.rounds }));
        let plan = null;
        if (!analysis.questions.length && !analysis.block_reason && analysis.test_target) {
          const snapshot = Snapshot.parse(await service(settings.runnerUrl, settings.runnerToken, '/snapshot'));
          if (inv.intake.repository_revision && inv.intake.repository_revision !== snapshot.commit_sha) analysis.block_reason = 'Supplied revision does not match the registered fixture.';
          else plan = buildPlan(snapshot, analysis.test_target, inv.intake.repeat_count);
        }
        await transaction(pool, async client => {
          const fresh = await locked(client, id);
          if (fresh.status !== 'analyzing' || fresh.cancel_requested_at) return;
          await client.query('UPDATE bugout.investigations SET analysis=$2 WHERE id=$1', [id, JSON.stringify(analysis)]);
          if (analysis.block_reason || (analysis.questions.length && fresh.current_round >= constants.limits.rounds)) {
            await client.query('UPDATE bugout.investigations SET incomplete_reason=$2 WHERE id=$1', [id, analysis.block_reason ?? 'Question round limit reached']);
            await transition(client, fresh, 'finalizing', 'Meaningful execution blocked');
          } else if (analysis.questions.length) {
            const expires = new Date(Math.min(Date.now() + settings.waitSeconds * 1000, fresh.deadline_at.getTime()));
            await client.query("INSERT INTO bugout.follow_up_rounds (id,investigation_id,round_number,questions,status,expires_at) VALUES ($1,$2,$3,$4,'open',$5)", [randomUUID(), id, fresh.current_round + 1, JSON.stringify(analysis.questions), expires]);
            await client.query('UPDATE bugout.investigations SET current_round=current_round+1,wait_expires_at=$2 WHERE id=$1', [id, expires]);
            await transition(client, fresh, 'awaiting_reporter', 'Missing documented test target');
          } else if (plan) {
            const expires = new Date(Math.min(Date.now() + settings.waitSeconds * 1000, fresh.deadline_at.getTime()));
            await client.query('UPDATE bugout.investigations SET plan=$2,plan_hash=$3,wait_expires_at=$4 WHERE id=$1', [id, JSON.stringify(plan), hash(plan), expires]);
            await transition(client, fresh, 'awaiting_approval', 'Exact plan ready for explicit confirmation');
          } else throw new Error('Analysis produced no actionable state');
        });
        continue;
      }
      if (inv.status === 'awaiting_reporter' || inv.status === 'awaiting_approval') {
        // Check stored approval before expiring the wait; the API only accepts
        // approval before its deadline, even if the worker resumes later.
        const approved = details.approvals.some(a => a.decision === 'approved' && a.plan_hash === inv.plan_hash);
        if (inv.status === 'awaiting_approval' && approved) {
          await transaction(pool, async client => {
            const fresh = await locked(client, id);
            if (fresh.cancel_requested_at) return;
            if (!fresh.plan || fresh.plan_hash !== hash(fresh.plan)) throw new Error('Approved plan hash mismatch');
            await client.query('INSERT INTO bugout.execution_runs (id,investigation_id,repeat_index,plan_hash) VALUES ($1,$2,1,$3)', [randomUUID(), id, fresh.plan_hash]);
            await client.query('UPDATE bugout.investigations SET wait_expires_at=NULL WHERE id=$1', [id]);
            await transition(client, fresh, 'running', 'Approved plan reserved for runner');
          });
          continue;
        }
        if (inv.wait_expires_at && inv.wait_expires_at <= new Date()) {
          await transaction(pool, async client => {
            const fresh = await locked(client, id);
            if (fresh.status !== inv.status) return;
            // Approval/reply could have committed between the read and row lock.
            const decisions = await client.query("SELECT 1 FROM bugout.approvals WHERE investigation_id=$1 AND plan_hash=$2 AND decision='approved'", [id, fresh.plan_hash]);
            if (decisions.rowCount) return;
            await client.query("UPDATE bugout.follow_up_rounds SET status='expired' WHERE investigation_id=$1 AND status='open'", [id]);
            await client.query('UPDATE bugout.investigations SET incomplete_reason=$2 WHERE id=$1', [id, `${inv.status} deadline expired`]);
            await transition(client, fresh, 'finalizing', 'Human wait expired');
          });
          continue;
        }
        return;
      }
      if (inv.status === 'running') {
        if (!inv.plan || !inv.plan_hash || hash(inv.plan) !== inv.plan_hash) throw new Error('Execution plan changed');
        if (currentRun) {
          const state = RunResult.parse(await service(settings.runnerUrl, settings.runnerToken, '/runs', {
            schema_version: 1, run_id: currentRun.id, investigation_id: id, plan: inv.plan, plan_hash: inv.plan_hash,
            approval: { actor: 'local-maintainer', signature: approvalSignature(settings.signingKey, id, currentRun.id, inv.plan_hash) },
          }));
          if (state.run_id !== currentRun.id) throw new Error('Runner returned a different run');
          if (state.state !== 'finished') return;
          if (!state.evidence) throw new Error('Runner finished without evidence');
          await saveEvidence(pool, inv, currentRun.id, state.evidence);
          continue;
        }
        await transaction(pool, async client => {
          const fresh = await locked(client, id);
          if (fresh.cancel_requested_at || fresh.status !== 'running') return;
          const canRepeat = details.runs.every(r => ['test_pass', 'test_failure'].includes(r.evidence?.classification));
          if (canRepeat && details.runs.length < fresh.plan!.repeats) {
            await client.query('INSERT INTO bugout.execution_runs (id,investigation_id,repeat_index,plan_hash) VALUES ($1,$2,$3,$4)', [randomUUID(), id, details.runs.length + 1, fresh.plan_hash]);
          } else await transition(client, fresh, 'finalizing', 'All bounded executions recorded');
        });
        continue;
      }
      if (inv.status === 'finalizing') {
        const acknowledged = await transaction(pool, async client => acknowledgeFinalizingCancellation(client, await locked(client, id)));
        if (acknowledged) continue; // Re-read cancellation metadata before report assembly.
        const report = ReportResult.parse(await service(settings.engineUrl, settings.engineToken, '/report', { investigation: inv, ...details }));
        await transaction(pool, async client => {
          const fresh = await locked(client, id);
          if (fresh.status !== 'finalizing') return;
          // Cancellation may race report assembly. Recompute on the next wake.
          if (Boolean(fresh.cancel_requested_at) !== Boolean(inv.cancel_requested_at)) return;
          await client.query('INSERT INTO bugout.reports (investigation_id,json_report,markdown,rule_version) VALUES ($1,$2,$3,$4) ON CONFLICT (investigation_id) DO NOTHING', [id, JSON.stringify(report.json), report.markdown, constants.rule_version]);
          await client.query('UPDATE bugout.investigations SET outcome=$2 WHERE id=$1', [id, report.outcome]);
          await transition(client, fresh, fresh.cancel_requested_at ? 'cancelled' : 'completed', 'JSON and Markdown reports saved');
        });
        return;
      }
    }
  } catch (error) {
    // A bounded durable budget survives new queue jobs/restarts.
    await transaction(pool, async client => {
      const inv = await locked(client, id); if (terminal.has(inv.status)) return;
      await client.query('UPDATE bugout.investigations SET failure_count=failure_count+1,updated_at=now() WHERE id=$1', [id]);
      if (inv.failure_count + 1 >= 3) {
        const hasUnresolvedRun = (await client.query(`SELECT 1 FROM bugout.execution_runs WHERE investigation_id=$1 AND ${UNRESOLVED_RUN}`, [id])).rowCount;
        if (hasUnresolvedRun) {
          // Fail finitely and expose unresolved cleanup. The independent runner
          // deadline still applies; a maintainer must inspect an unreachable runner.
          await client.query("UPDATE bugout.investigations SET cancel_requested_at=COALESCE(cancel_requested_at,now()),cleanup_status='unconfirmed',incomplete_reason='Runner communication failed; cleanup unconfirmed' WHERE id=$1", [id]);
          await transition(client, inv, 'failed', 'Runner unavailable after bounded attempts; cleanup unconfirmed');
        } else {
          await client.query("UPDATE bugout.investigations SET incomplete_reason='Required service unavailable or invalid after bounded attempts' WHERE id=$1", [id]);
          await transition(client, inv, inv.status === 'finalizing' ? 'failed' : 'finalizing', 'Dependency failure budget exhausted');
        }
      }
    });
    throw error;
  } finally {
    try { await guard.query('SELECT pg_advisory_unlock(hashtextextended($1,1))', [id]); }
    finally { guard.release(); }
  }
}

async function saveEvidence(pool: Pool, inv: Investigation, runId: string, raw: unknown) {
  const evidence = Evidence.parse(raw);
  if (evidence.run_id !== runId || evidence.investigation_id !== inv.id || evidence.plan_hash !== inv.plan_hash || hash(evidence.repository) !== hash(inv.plan!.repository) || hash(evidence.argv) !== hash(inv.plan!.argv)) throw new Error('Runner evidence does not match approved execution');
  await transaction(pool, async client => {
    await client.query('UPDATE bugout.execution_runs SET evidence=$2,runner_status=$3,updated_at=now() WHERE id=$1 AND evidence IS NULL', [runId, JSON.stringify(evidence), 'finished']);
    if (evidence.cleanup !== 'completed') {
      const fresh = await locked(client, inv.id);
      await client.query("UPDATE bugout.investigations SET cleanup_status='failed',incomplete_reason='Runner could not confirm cleanup' WHERE id=$1", [inv.id]);
      await transition(client, fresh, 'failed', 'Cleanup failure; explicit operator inspection required');
    }
  });
}
