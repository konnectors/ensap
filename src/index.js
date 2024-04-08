process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://783765ad8f0542ce9d961b2ef487cd57@errors.cozycloud.cc/20'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  utils,
  cozyClient
} = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

const request = requestFactory({
  // debug: true,
  json: true,
  jar: true
})

const crypto = require('crypto')

const VENDOR = 'Ensap'
const baseUrl = 'https://ensap.gouv.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  await this.deactivateAutoSuccessfulLogin()
  await authenticate(fields.login, fields.password)
  await this.notifySuccessfulLogin()

  const { yearsPaie } = await getYears()
  if (yearsPaie) {
    log('info', 'Found Remuneration type docs, fetching them...')
    for (const yearPaie of yearsPaie) {
      const files = await fetchFiles(yearPaie)
      const { docs, bills } = await parseDocuments(files, 'paie')
      if (bills.length)
        // We update the isRefund attribute if missing due to 1.5.0
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef'],
          identifiers: ['ddfip', 'drfip', 'paye', 'remuneration'],
          shouldUpdate: function (newBill, dbEntry) {
            const result = newBill.isRefund && !dbEntry.isRefund
            return result
          },
          // Now needed to avoid MIMETYPE errors
          validateFile: () => true
        })
      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef'],
          identifiers: ['ddfip', 'drfip', 'paye', 'remuneration'],
          // Now needed to avoid MIMETYPE errors
          validateFile: () => true
        })
    }
  }
  // The account we have to dev is not containing any "pension"
  // As it is suspected that all files are now returned by years independently of if it is a "pension" or a "paie"
  // We keep this code around while verifying
  // if (yearsPension) {
  //   log('info', 'Found Pension type docs, fetching them...')
  //   for (const yearPension of yearsPension) {
  //     const files = await fetchFilesPension(yearPension)
  //     const { docs, bills } = await parseDocuments(files, 'pension')
  //     if (bills.length)
  //       await this.saveBills(bills, fields, {
  //         fileIdAttributes: ['vendorRef']
  //       })
  //     if (docs.length)
  //       await this.saveFiles(docs, fields, {
  //         contentType: 'application/pdf',
  //         fileIdAttributes: ['vendorRef']
  //       })
  //   }
  // }
}
async function authenticate(login, password) {
  const resp = await request({
    uri: `${baseUrl}/`,
    method: 'POST',
    Headers: { 'Content-Type': 'application/json' },
    formData: { identifiant: login, secret: password },
    resolveWithFullResponse: true
  })

  const respBody = resp.body
  if (respBody.message.includes('ou mot de passe')) {
    throw new Error(errors.LOGIN_FAILED)
  } else if (
    respBody.message.includes('Authentification OK') &&
    resp.statusCode === 200
  ) {
    return
  } else if (respBody.message.includes('bloqué')) {
    log('error', respBody)
    throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
  } else {
    log('error', respBody)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function getYears() {
  // Set up XSRF-Token
  await request({
    uri: `${baseUrl}/prive/initialiserhabilitation/v1`,
    method: 'POST',
    body: {}
  })
  const resp = await request({
    uri: `${baseUrl}/prive/listeranneeremunerationpaie/v1`,
    method: 'GET',
    resolveWithFullResponse: true
  })
  let listeAnnee = resp.body.listeAnnee
  if (listeAnnee) {
    listeAnnee = listeAnnee.sort().reverse()
  }
  if (listeAnnee) {
    return {
      yearsPaie: listeAnnee
    }
  } else {
    log('warn', 'could not find year of remuneration')
    return {}
  }
}

function fetchFiles(year) {
  log('info', `Fetching files paie for year ${year}`)
  return request.get(`${baseUrl}/prive/remunerationpaie/v1?annee=${year}`, {
    json: true
  })
}

// function fetchFilesPension(year) {
//   log('info', `Fetching files pension for year ${year}`)
//   return request.get(`${baseUrl}/prive/remunerationpension/v1?annee=${year}`, {
//     json: true
//   })
// }

async function parseDocuments(files, type = 'paie') {
  const docs = []
  const bills = []
  for (const file of files) {
    // For each file get the pdf url and metadata
    const uuid = file.documentUuid
    // Switching url if we have pension documents
    let fileurl = `${baseUrl}/prive/telechargerremunerationpaie/v1?documentUuid=${uuid}`
    if (type === 'pension') {
      fileurl = `${baseUrl}/prive/telechargerremunerationpension/v1?documentUuid=${uuid}`
    }
    let filename = file.libelle2
    // Try to replace _XX_ known type_
    filename = filename.replace(/_AF_/, '_Attestation_fiscale_')
    filename = filename.replace(/_AFENS_/, '_Attestation_fiscale_')
    filename = filename.replace(/_AFPENS_/, '_Attestation_fiscale_')
    filename = filename.replace(/_DR_/, '_Décompte_de_rappel_')
    if (type === 'pension') {
      filename = filename.replace(/_BP_/, '_Bulletin_de_pension_')
      filename = filename.replace(/_BPENS_/, '_Bulletin_de_pension_')
    } else {
      filename = filename.replace(/_BP_/, '_Bulletin_de_paie_')
      filename = filename.replace(/_BPENS_/, '_Bulletin_de_paie_')
    }
    filename = filename.replace(
      /\.pdf$/,
      `_${crypto
        .createHash('sha1')
        .update(uuid)
        .digest('hex')
        .substr(0, 5)}.pdf`
    )
    // Date is set to 22 of the month for easier matching, if not BP is always at 1st
    let datePlus21 = new Date(file.dateDocument)
    datePlus21.setDate(datePlus21.getDate() + 21)
    const amount = parseFloat(file.libelle3?.replace(' ', '').replace(',', '.'))
    const vendor = VENDOR
    // This doc have no amount in libelle3, make a file only.
    if (filename.includes('rappel') || filename.includes('Attestation')) {
      const doc = {
        fileurl,
        filename,
        vendorRef: uuid,
        fileAttributes: {
          metadata: {
            datetime: utils.formatDate(new Date()),
            datetimeLabel: 'issueDate',
            contentAuthor: 'ensap.gouv.fr',
            carbonCopy: true,
            qualification: Qualification.getByLabel('other_revenue')
          }
        }
      }
      docs.push(doc)
    } else if (filename.includes('Bulletin') && Boolean(amount)) {
      // This doc have amount, it's a bill !
      const doc = {
        date: datePlus21,
        fileurl,
        filename,
        amount,
        isRefund: true,
        vendor,
        vendorRef: uuid,
        type: 'income',
        fileAttributes: {
          metadata: {
            datetime: utils.formatDate(new Date()),
            datetimeLabel: 'issueDate',
            contentAuthor: 'ensap.gouv.fr',
            carbonCopy: true,
            qualification: Qualification.getByLabel('pay_sheet')
          }
        }
      }
      bills.push(doc)
    } else {
      log('warn', `Unkown type for one doc, discarding this one : ${filename}`)
    }
  }
  return { docs, bills }
}
