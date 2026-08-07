-- =======================================================
-- SEED SCRIPT FOR admin@espressgo.local (Password: 1234567890)
-- =======================================================

-- 1. Create Supabase Auth User
-- create the supabase admin@espressgo.local in the authentication page 


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
