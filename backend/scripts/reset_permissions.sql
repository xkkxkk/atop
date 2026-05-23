-- Reset role permissions to re-seed with new defaults
-- Run this ONCE after deploying the new backend
-- WARNING: This will clear all custom permission overrides
DELETE FROM role_permissions;
-- The backend will re-seed on next startup via SeedDefaultPermissions()
