// El acceso administrativo se configura en el servidor; nunca sale del rol
// dueño/cajero ni de un valor enviado por el cliente o guardado en el JWT.
function isAdminEmail(email) {
  if (typeof email !== 'string') return false;
  return (process.env.ADMIN_EMAILS || '').split(',')
    .map(value => value.trim().toLowerCase()).filter(Boolean)
    .includes(email.trim().toLowerCase());
}

module.exports = { isAdminEmail };
