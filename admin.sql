UPDATE public.profiles 
SET is_admin = true 
WHERE id = (
    SELECT id FROM auth.users 
    WHERE email = 'berlecka@8master.game'
);