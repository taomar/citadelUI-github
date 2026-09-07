import { sha256 } from './directory-provider.mjs';
import { activeWorkspace } from './workspace-context.mjs';

function notFound(error) {
  return error?.name === 'NotFoundError' || /not found/i.test(error?.message || '');
}

async function createdDirectorySnapshot(provider, files) {
  const creations = files.filter((file) => file.create);
  if (creations.length && typeof provider.missingDirectories !== 'function') {
    throw new Error('Source provider cannot journal created directories.');
  }
  return [
    ...new Set(
      (
        await Promise.all(
          creations.map((file) => provider.missingDirectories(file.alias))
        )
      ).flat()
    ),
  ].sort(
    (left, right) =>
      left.split('/').length - right.split('/').length || left.localeCompare(right)
  );
}

export function createTransactionCommit(request) {
  return async function commitFiles(files, options = {}) {
    const { projectId, environment, provider } = options.context || activeWorkspace();
    // Optional operation-specific freshness proof (migration also binds donor
    // and schema reads). The existing destination hash checks remain mandatory.
    await options.validateBeforeWrite?.();
    const preparedFiles = await Promise.all(
      files.map(async (file) => ({
        ...file,
        afterHash: await sha256(file.after),
        afterSize: file.after.byteLength,
        beforeSize: file.before?.byteLength ?? 0,
      }))
    );
    const createdDirectories = await createdDirectorySnapshot(provider, preparedFiles);
    const preparation = await request('/api/transactions/prepare', {
      method: 'POST',
      body: JSON.stringify({
        environmentId: environment.id,
        environmentLabel: environment.label,
        targetId: projectId,
        targetLabel: options.action || 'edit',
        changedAliases: preparedFiles.map((file) => file.alias),
        changedNames: Object.fromEntries(
          preparedFiles.map((file) => [file.alias, file.changed || []])
        ),
        createdDirectories,
        files: preparedFiles.map((file) => ({
          alias: file.alias,
          existed: !file.create,
          hash: file.beforeHash,
          size: file.beforeSize,
        })),
      }),
    });
    const transactionId = preparation.transaction.transactionId;
    const transactionToken = preparation.transactionToken;
    const environmentHeaders = {
      'X-Citadel-Environment': environment.id,
      'X-Citadel-Transaction': transactionToken,
    };
    let authorization = null;
    let committing = false;
    const written = [];

    try {
      for (const file of preparedFiles.filter((item) => !item.create)) {
        const manifestFile = preparation.transaction.files.find((entry) => entry.alias === file.alias);
        await request(
          `/api/transactions/${encodeURIComponent(transactionId)}/backups/${encodeURIComponent(manifestFile.id)}`,
          {
            method: 'PUT',
            headers: {
              ...environmentHeaders,
              'Content-Type': 'application/octet-stream',
              'X-Citadel-Content-SHA256': file.beforeHash,
            },
            body: file.before,
          }
        );
      }

      authorization = await request(
        `/api/transactions/${encodeURIComponent(transactionId)}/authorize`,
        {
          method: 'POST',
          headers: environmentHeaders,
          body: JSON.stringify({}),
        }
      );

      await options.validateBeforeWrite?.();
      for (const file of preparedFiles) {
        if (file.create) {
          try {
            await provider.read(file.alias);
            throw new Error(`Source was created externally before write: ${file.alias}`);
          } catch (error) {
            if (!notFound(error)) throw error;
          }
        } else {
          const current = await provider.read(file.alias);
          if (current.hash !== file.beforeHash) {
            throw new Error('File changed outside Citadel UI. Reload before saving.');
          }
        }
      }
      const currentCreatedDirectories = await createdDirectorySnapshot(
        provider,
        preparedFiles
      );
      if (
        JSON.stringify(currentCreatedDirectories) !== JSON.stringify(createdDirectories)
      ) {
        throw new Error(
          'Source directories changed outside Citadel UI. Retry the operation.'
        );
      }

      await request(`/api/transactions/${encodeURIComponent(transactionId)}/committing`, {
        method: 'POST',
        headers: {
          ...environmentHeaders,
          'X-Citadel-Authorization': authorization.authorizationToken,
        },
        body: JSON.stringify({
          manifestHash: authorization.manifestHash,
          files: preparedFiles.map((file) => ({
            alias: file.alias,
            originalHash: file.beforeHash,
            finalHash: file.afterHash,
            finalSize: file.afterSize,
          })),
        }),
      });
      committing = true;

      for (const file of preparedFiles) {
        await options.validateBeforeWrite?.();
        const verified = await provider.write(file.alias, file.after, {
          create: Boolean(file.create),
          expectedHash: file.create ? null : file.beforeHash,
          finalHash: file.afterHash,
          validateBeforeWrite: options.validateBeforeWrite,
        });
        written.push({ ...file, finalHash: verified.hash });
      }

      await request(`/api/transactions/${encodeURIComponent(transactionId)}/receipt`, {
        method: 'POST',
        headers: {
          ...environmentHeaders,
          'X-Citadel-Authorization': authorization.authorizationToken,
        },
        body: JSON.stringify({
          receipts: written.map((file) => ({
            alias: file.alias,
            hash: file.finalHash,
            size: file.afterSize,
          })),
        }),
      });
      return {
        transactionId,
        files: written.map((file) => ({ alias: file.alias, hash: file.finalHash })),
      };
    } catch (error) {
      if (!committing) {
        await request(`/api/transactions/${encodeURIComponent(transactionId)}/fail`, {
          method: 'POST',
          headers: environmentHeaders,
          body: JSON.stringify({ changedAliases: [] }),
        }).catch(() => {});
        throw error;
      }

      const rollback = [];
      for (const file of [...written].reverse()) {
        try {
          const current = await provider.read(file.alias);
          if (current.hash !== file.finalHash) {
            throw new Error(
              'Source changed outside Citadel UI after this transaction wrote it.'
            );
          }
          if (file.create) {
            await provider.remove(file.alias, {
              expectedHash: file.finalHash,
              removeEmptyDirectories: createdDirectories.filter((directory) =>
                file.alias.startsWith(`${directory}/`)
              ),
            });
          } else {
            const manifestFile = preparation.transaction.files.find((entry) => entry.alias === file.alias);
            const backup = await request(
              `/api/transactions/${encodeURIComponent(transactionId)}/backups/${encodeURIComponent(manifestFile.id)}?environmentId=${encodeURIComponent(environment.id)}`,
              {
                responseType: 'bytes',
                headers: { 'X-Citadel-Transaction': transactionToken },
              }
            );
            await provider.write(file.alias, backup.bytes, {
              expectedHash: file.finalHash,
              finalHash: file.beforeHash,
            });
          }
          rollback.push({ alias: file.alias, restored: true });
        } catch (rollbackError) {
          rollback.push({ alias: file.alias, restored: false, error: rollbackError.message });
        }
      }

      const receipts = [];
      const incomplete = rollback.filter((item) => !item.restored);
      for (const file of preparedFiles) {
        try {
          if (file.create) {
            try {
              await provider.read(file.alias);
              incomplete.push({
                alias: file.alias,
                restored: false,
                error: 'A source expected to be absent is present.',
              });
            } catch (readError) {
              if (!notFound(readError)) throw readError;
              receipts.push({ alias: file.alias, removed: true });
            }
          } else {
            const current = await provider.read(file.alias);
            if (current.hash !== file.beforeHash) {
              incomplete.push({
                alias: file.alias,
                restored: false,
                error: 'Source does not match its pre-transaction hash.',
              });
            } else {
              receipts.push({
                alias: file.alias,
                hash: file.beforeHash,
                size: file.beforeSize,
              });
            }
          }
        } catch (inspectionError) {
          incomplete.push({
            alias: file.alias,
            restored: false,
            error: inspectionError.message,
          });
        }
      }

      if (incomplete.length) {
        const unresolved = [...new Set(incomplete.map((item) => item.alias))];
        await request(`/api/transactions/${encodeURIComponent(transactionId)}/fail`, {
          method: 'POST',
          headers: environmentHeaders,
          body: JSON.stringify({ changedAliases: unresolved }),
        }).catch(() => {});
        throw new Error(
          `${error.message} Recovery still requires attention for ${unresolved.join(', ')}.`
        );
      }
      await request(`/api/transactions/${encodeURIComponent(transactionId)}/rollback`, {
        method: 'POST',
        headers: environmentHeaders,
        body: JSON.stringify({ receipts }),
      }).catch(() => {});
      throw error;
    }
  };
}
