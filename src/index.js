process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://ea724fef74ee48889c9a788643f96a48@sentry.cozycloud.cc/123'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors
} = require('cozy-konnector-libs')

const request = requestFactory({
  debug: true,
  json: true,
  jar: true
})

const VENDOR = 'Ensap'
const baseUrl = 'https://ensap.gouv.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  await this.deactivateAutoSuccessfulLogin()
  await authenticate(fields.identifiant, fields.secret)
  await this.notifySuccessfulLogin()

  const documents = await getDocs()

  for (const doc of documents) {
    let oneFile = []

    await request({
      uri: `${baseUrl}/prive/initialiserhabilitation/v1`,
      method: 'POST',
      body: {},
      resolveWithFullResponse: true
    })
    let resp = await request({
      uri: `${baseUrl}/prive/accueilconnecte/v1`,
      resolveWithFullResponse: true
    })
    await request({
      uri: `${baseUrl}/prive/verifiersession/v1`,
      method: 'POST',
      headers: {},
      body: {},
      resolveWithFullResponse: true
    })

    let neededCookies = resp.headers['set-cookie']
    let test = neededCookies[0]

    let cookieSplit = test.split('; ')
    let cookieObject = {}
    cookieSplit.forEach(function(value) {
      let splitResult = value.split('=')
      cookieObject[splitResult[0]] = splitResult[1]
    })

    let stringedAmount = doc.libelle3.replace(',', '.')

    oneFile.push({
      ...doc,
      date: new Date('January 12, 2022'),
      vendor: VENDOR,
      vendorRef: doc.evenementId,
      amount: parseFloat(stringedAmount),
      fileurl: `${baseUrl}/prive/telechargerremunerationpaie/v1?documentUuid=${doc.documentUuid}`,
      filename: `${doc.libelle1.toLowerCase().replace(/ /g, '_')}.pdf`,
      requestOptions: {
        headers: {
          'X-XSRF-TOKEN': `${cookieObject['XSRF-TOKEN']}`
        },
        cookie: {
          neededCookies
        }
      },
      fileAttributes: {
        metadata: {
          issueDate: '',
          datetimeLabel: 'issueDate',
          contentAuthor: 'ensap.gouv.fr'
        }
      }
    })
    log('info', oneFile)
    if (doc.service === 'remuneration') {
      await this.saveBills(oneFile, fields, {
        fileIdAttributes: ['vendorRef'],
        linkBankOperations: false,
        identifiers: ['Ensap'],
        sourceAccountIdentifier: fields.identifiant
      })
    }
  }
}
async function authenticate(username, password) {
  let resp = await request({
    uri: `${baseUrl}/`,
    method: 'POST',
    Headers: { 'Content-Type': 'application/json' },
    formData: { identifiant: username, secret: password },
    resolveWithFullResponse: true
  })
  resp = resp.body

  if (resp.message.includes('Identifiant ou mot de passe erroné')) {
    throw new Error(errors.LOGIN_FAILED)
  } else if (resp.message.includes('Authentification OK')) {
    return
  } else if (
    resp.message.includes('Ce compte est temporairement bloqué pendant')
  ) {
    log('error', resp)
    throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
  } else {
    log('error', resp)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function getDocs() {
  await request({
    uri: `${baseUrl}/prive/initialiserhabilitation/v1`,
    method: 'POST',
    body: {},
    resolveWithFullResponse: true
  })
  let resp = await request({
    uri: `${baseUrl}/prive/accueilconnecte/v1`,
    resolveWithFullResponse: true
  })

  let neededCookies = resp.headers['set-cookie']
  log('info', neededCookies[0])

  let downloadDocs = []
  for (const evenement of resp.body.donnee.listeEvenement) {
    downloadDocs.push({
      ...evenement
    })
  }
  return downloadDocs
}
