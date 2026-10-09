```typescript
// ... código anterior ...

// Função original que realiza N+1 atualizações
async function upsertGroupState(groups: GroupState[]) {
  for (const group of groups) {
    const { error } = await supabase
      .from('groups')
      .update({
        state: group.state,
        last_updated: new Date().toISOString(),
      })
      .eq('contract_id', group.contract_id);

    if (error) {
      throw error;
    }
  }
}

// Função modificada para realizar um único bulk update
async function upsertGroupState(groups: GroupState[]) {
  // Verifica se há grupos para atualizar
  if (groups.length === 0) {
    throw new Error('No groups to update');
  }

  // Cria um array de valores para o bulk update
  const values = groups.map(group => `('${group.contract_id}', '${group.state}', '${new Date().toISOString()}')`).join(', ');

  // Executa o bulk update usando uma consulta SQL
  const { error } = await supabase
    .rpc('bulk_update_groups', {
      values: values
    });

  if (error) {
    throw error;
  }
}

// ... código posterior ...
```
<<<ENDFILE>>
