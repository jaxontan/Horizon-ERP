-- =======================================================
-- SEED SCRIPT FOR admin@espressgo.local (Password: 1234567890)
-- =======================================================

-- 1. Create Supabase Auth User
INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin,
    created_at,
    updated_at
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    '580c584d-900d-4950-bbc0-e01f1dbb751f',
    'authenticated',
    'authenticated',
    'admin@espressgo.local',
    '$2a$10$TGuddt3VQcwah2812DreDulB1bE/3VhtyEOMy2mtn6XkrJoN94GCO',
    NOW(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{"name": "Admin", "email_verified": true}'::jsonb,
    FALSE,
    NOW(),
    NOW()
) ON CONFLICT (id) DO NOTHING;

-- 2. Create Auth Identity Link
INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
) VALUES (
    '0b7e471e-f06c-4c34-9079-9a4cccc2b120',
    '580c584d-900d-4950-bbc0-e01f1dbb751f',
    '{"sub": "580c584d-900d-4950-bbc0-e01f1dbb751f", "email": "admin@espressgo.local", "email_verified": true, "phone_verified": false}'::jsonb,
    'email',
    '580c584d-900d-4950-bbc0-e01f1dbb751f',
    NOW(),
    NOW(),
    NOW()
) ON CONFLICT (id) DO NOTHING;

-- 3. Create Staff Profile (ERP Application Admin Access)
INSERT INTO public.staff_profiles (
    id,
    staff_code,
    name,
    email,
    assigned_roles,
    is_active,
    role,
    department,
    employment_status,
    created_at,
    updated_at
) VALUES (
    '427e2074-c260-4b48-8a0e-4fca1796c4f4',
    'STF-004',
    'Admin',
    'admin@espressgo.local',
    '[]'::jsonb,
    TRUE,
    'admin',
    'Administration',
    'active',
    NOW(),
    NOW()
) ON CONFLICT (id) DO NOTHING;
