// 只读取抖音私信运行时确认的当前登录用户，缓存中的历史账号不作为身份依据。
export function currentAccount(store) {
  const uid = store?.curLoginUserInfo?.uid
  return typeof uid === 'string' && /^[1-9]\d{0,30}$/.test(uid) ? uid : ''
}
