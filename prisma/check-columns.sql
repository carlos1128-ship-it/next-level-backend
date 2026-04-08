-- Verifica a estrutura da tabela Company
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'Company'
AND column_name LIKE '%whatsapp%'
ORDER BY column_name;
