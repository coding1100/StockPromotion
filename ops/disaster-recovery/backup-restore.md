# Backup And Restore Playbook

## Backup
1. Run:
   - `npm run ops:backup-db`
2. Store output from `app/backups` in encrypted object storage.
3. Record backup checksum and timestamp.

## Restore Drill
1. Select latest backup artifact.
2. Restore:
   - `npm run ops:restore-db -- -BackupFile .\backups\<file>.dump -DropExisting`
3. Verify:
   - `npm run ops:verify-restore`

## Drill Frequency
- At least once per sprint for staging.
- At least monthly for production-like backup artifact.
