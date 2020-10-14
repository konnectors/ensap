process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://ea724fef74ee48889c9a788643f96a48@sentry.cozycloud.cc/123'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors
} = require('cozy-konnector-libs')
const DEBUG = false
const request = requestFactory({
  debug: DEBUG,
  json: false,
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
  const { yearsPaie, yearsPension } = await getYears()
  if (yearsPaie) {
    log('info', 'Found Remuneration type docs, fetching them...')
    for (const yearPaie of yearsPaie) {
      const files = await fetchFiles(yearPaie)
      const { docs, bills } = await parseDocuments(files, 'paie')
      if (bills.length)
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef'],
          linkBankOperations: false
        })
      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
        fileIdAttributes: ['vendorRef']
        })
    }
  }
  if (yearsPension) {
    log('info', 'Found Pension type docs, fetching them...')
    for (const yearPension of yearsPension) {
      const files = await fetchFilesPension(yearPension)
      const { docs, bills } = await parseDocuments(files, 'pension')
      if (bills.length)
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef'],
          linkBankOperations: false
        })
      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
        fileIdAttributes: ['vendorRef']
        })
    }
  }
}

async function getYears() {
  const  resp  = await request.get(
    `${baseUrl}/prive/accueilconnecte/v1`,
    {
      json: true
    }
  )
  let listeAnneeRemunerationPension = resp.listeAnneeRemunerationPension
  let listeAnneeRemuneration = resp.listeAnneeRemuneration
  if (listeAnneeRemuneration && listeAnneeRemuneration.reverse) {
    listeAnneeRemuneration = listeAnneeRemuneration.sort().reverse()
  }
  if (listeAnneeRemunerationPension && listeAnneeRemunerationPension.reverse) {
    listeAnneeRemunerationPension = listeAnneeRemunerationPension.sort().reverse()
  }

  if (listeAnneeRemuneration || listeAnneeRemunerationPension) {
    return { yearsPaie: listeAnneeRemuneration, yearsPension: listeAnneeRemunerationPension }
  } else {
    log('warn', 'could not find year of remuneration')
    return {}
  }
}

async function authenticate(username, password) {
  const resp = await request({
    uri: `${baseUrl}/authentification`,
    method: 'POST',
    formData: { identifiant: username, secret: password }
  })
  if (resp.includes('Identifiant ou mot de passe erroné')) {
    throw new Error(errors.LOGIN_FAILED)
  } else if (resp.includes('Authentification OK')) {
    return
  } else if (resp.includes('Ce compte est temporairement bloqué pendant')) {
    log('error', resp)
    throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
  } else {
    log('error', resp)
    throw new Error(errors.VENDOR_DOWN)
  }
}

function fetchFiles(year) {
  log('info', `Fetching files paie for year ${year}`)
  return request.get(`${baseUrl}/prive/remunerationpaie/v1?annee=${year}`, {
    json: true
  })
}

function fetchFilesPension(year) {
  log('info', `Fetching files pension for year ${year}`)
  return request.get(`${baseUrl}/prive/remunerationpension/v1?annee=${year}`, {
    json: true
  })
}

async function parseDocuments(files, type='paie') {
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
    let filename = file.nomDocument
    // Try to replace _XX_ known type_
    filename.replace(/_AF_/, '_Attestation_fiscale_')
    filename.replace(/_AFENS_/, '_Attestation_fiscale_')
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
    const amount = parseFloat(file.libelle3.replace(' ', '').replace(',', '.'))
    const vendor = VENDOR

    // This doc have no amount in libelle3, make a file only.
    if (file.icone === 'rappel' || file.icone === 'attestation'
        || file.icone === 'attestation-pension') {
      const doc = {
        fileurl,
        filename,
        vendorRef: uuid
      }
      docs.push(doc)
    } else if (file.icone === 'document' || file.icone === 'document-pension') {
      // This doc have amount, it's a bill !
      const doc = {
        date: datePlus21,
        fileurl,
        filename,
        amount,
        isRefund: true,
        vendor,
        vendorRef: uuid,
        type: 'income'
      }
      bills.push(doc)
    } else {
      log(
        'warn',
        `Unkown type for one doc, discarding this one : ${file.icone}`
      )
    }
  }
  return { docs, bills }
}

// ;[
//   {
//     documentUuid: '31eae07d-5816-4c1a-b43f-d3bb2309f9af',
//     libelle1: 'Attestation fiscale 2018',
//     libelle2: '2018_01_AF_janvier.pdf (PDF, 10 Ko)',
//     libelle3: '',
//     nomDocument: '2018_01_AF_janvier.pdf',
//     dateDocument: '2019-01-10T14:59:35.158+0100',
//     annee: 2019,
//     icone: 'attestation',
//     libelleIcone: 'Icône attestation fiscale'
//   },
//   {
//     documentUuid: 'f0330e9f-e424-4a75-9e64-a42837a2a1b8',
//     libelle1: 'Janvier 2019',
//     libelle2: '2019_01_BP_janvier.pdf (PDF, 21 Ko)',
//     libelle3: '1 919,21 €',
//     nomDocument: '2019_01_BP_janvier.pdf',
//     dateDocument: '2019-01-01T12:00:00.000+0100',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: '9d2b476e-c5fc-4073-81f2-2806c181b8da',
//     libelle1: 'Attestation fiscale 2018',
//     libelle2: '2018_01_AF_janvier.pdf (PDF, 10 Ko)',
//     libelle3: '',
//     nomDocument: '2018_01_AF_janvier.pdf',
//     dateDocument: '2019-01-16T07:12:59.407+0100',
//     annee: 2019,
//     icone: 'attestation',
//     libelleIcone: 'Icône attestation fiscale'
//   },
//   {
//     documentUuid: '6e19b746-ae21-4d91-ac67-9b5edb804325',
//     libelle1: 'Février 2019',
//     libelle2: '2019_02_BP_fevrier.pdf (PDF, 21 Ko)',
//     libelle3: '2 083,22 €',
//     nomDocument: '2019_02_BP_fevrier.pdf',
//     dateDocument: '2019-02-01T12:00:00.000+0100',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: 'f0eec030-040d-4e05-ac20-a8f695edc83b',
//     libelle1: 'Mars 2019',
//     libelle2: '2019_03_BP_mars.pdf (PDF, 21 Ko)',
//     libelle3: '2 034,94 €',
//     nomDocument: '2019_03_BP_mars.pdf',
//     dateDocument: '2019-03-01T12:00:00.000+0100',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: 'aab30da2-fe2b-4d47-accb-13233518d4b3',
//     libelle1: 'Avril 2019',
//     libelle2: '2019_04_BP_avril.pdf (PDF, 21 Ko)',
//     libelle3: '2 282,50 €',
//     nomDocument: '2019_04_BP_avril.pdf',
//     dateDocument: '2019-04-01T12:00:00.000+0200',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: '9e2b2e6f-8775-465e-8119-d5f1f022a4fc',
//     libelle1: 'Mai 2019',
//     libelle2: '2019_05_BP_mai.pdf (PDF, 25 Ko)',
//     libelle3: '1 943,15 €',
//     nomDocument: '2019_05_BP_mai.pdf',
//     dateDocument: '2019-05-01T00:00:00.000+0200',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: '7c3a838e-0cfb-4a7f-818b-635f2579dcd0',
//     libelle1: 'Juin 2019',
//     libelle2: '2019_06_BP_juin.pdf (PDF, 25 Ko)',
//     libelle3: '2 767,60 €',
//     nomDocument: '2019_06_BP_juin.pdf',
//     dateDocument: '2019-06-01T00:00:00.000+0200',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: '9fa2de4d-69c2-470a-a069-d596f139e1d2',
//     libelle1: 'Juillet 2019',
//     libelle2: '2019_07_BP_juillet.pdf (PDF, 25 Ko)',
//     libelle3: '1 982,77 €',
//     nomDocument: '2019_07_BP_juillet.pdf',
//     dateDocument: '2019-07-01T00:00:00.000+0200',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: '287ce045-edfa-4283-a6a3-caa90fb8b61a',
//     libelle1: 'Août 2019',
//     libelle2: '2019_08_BP_aout.pdf (PDF, 25 Ko)',
//     libelle3: '1 745,23 €',
//     nomDocument: '2019_08_BP_aout.pdf',
//     dateDocument: '2019-08-01T00:00:00.000+0200',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: '5fe282ed-7179-4d63-9d0d-2d967c651fd9',
//     libelle1: 'Septembre 2019',
//     libelle2: '2019_09_BP_septembre.pdf (PDF, 25 Ko)',
//     libelle3: '1 780,97 €',
//     nomDocument: '2019_09_BP_septembre.pdf',
//     dateDocument: '2019-09-01T00:00:00.000+0200',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   },
//   {
//     documentUuid: '8a14678c-9c05-4da3-8f55-9612368ba4ed',
//     libelle1: 'Octobre 2019',
//     libelle2: '2019_10_BP_octobre.pdf (PDF, 25 Ko)',
//     libelle3: '1 765,28 €',
//     nomDocument: '2019_10_BP_octobre.pdf',
//     dateDocument: '2019-10-01T00:00:00.000+0200',
//     annee: 2019,
//     icone: 'document',
//     libelleIcone: 'Icône bulletin de paye'
//   }
// ]
