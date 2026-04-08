-- Verifica se as colunas existem e as limpa
DO $$
BEGIN
  -- Verifica se a coluna whatsappSessionName existe
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'Company' 
    AND column_name = 'whatsappSessionName'
  ) THEN
    UPDATE "Company" SET "whatsappSessionName" = NULL;
    RAISE NOTICE 'Coluna whatsappSessionName limpa';
  ELSE
    RAISE NOTICE 'Coluna whatsappSessionName nao existe';
  END IF;

  -- Verifica se a coluna whatsappWid existe
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'Company' 
    AND column_name = 'whatsappWid'
  ) THEN
    UPDATE "Company" SET "whatsappWid" = NULL;
    RAISE NOTICE 'Coluna whatsappWid limpa';
  ELSE
    RAISE NOTICE 'Coluna whatsappWid nao existe';
  END IF;
END $$;
