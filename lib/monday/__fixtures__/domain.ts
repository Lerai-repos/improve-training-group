import type {
  MondayKlant,
  MondayQualification,
  MondayThema,
  MondayTrainer,
  MondayTraining,
} from '../types';

/**
 * Default normalized domain fixtures — a small, self-consistent graph (external
 * ids line up across trainings/trainers/themes/klanten). Powers the mock port
 * and the offline seed, so the whole stack runs with no live Monday.
 */

const BOARD_TRAINERS = '1661151090';
const BOARD_THEMAS = '5067928440';
const BOARD_AGENDA = '5087396949';

export const DEFAULT_TRAINERS: MondayTrainer[] = [
  {
    externalItemId: '1661150001',
    externalBoardId: BOARD_TRAINERS,
    naam: 'Anna de Vries',
    adres: 'Keizersgracht 1, Amsterdam',
    email: 'anna@example.com',
    telefoon: '0612345678',
    rateKey: '2024-heden',
  },
  {
    externalItemId: '1661150002',
    externalBoardId: BOARD_TRAINERS,
    naam: 'Ben Jansen',
    adres: 'Coolsingel 10, Rotterdam',
    email: 'ben@example.com',
    telefoon: '0687654321',
    rateKey: '2020-2024',
  },
];

export const DEFAULT_THEMAS: MondayThema[] = [
  {
    externalItemId: '5067920001',
    externalBoardId: BOARD_THEMAS,
    thema: 'Feedback geven',
  },
  {
    externalItemId: '5067920002',
    externalBoardId: BOARD_THEMAS,
    thema: 'Timemanagement',
  },
];

export const DEFAULT_KLANTEN: MondayKlant[] = [
  { externalItemId: '9000000001', klantnaam: 'Acme BV' },
];

export const DEFAULT_TRAININGS: MondayTraining[] = [
  {
    externalItemId: '5087400001',
    externalBoardId: BOARD_AGENDA,
    externalGroupId: 'topics',
    datum: '2026-03-15',
    tijd: '09:00',
    taal: 'nl',
    duurTraining: 3,
    status: 'Nieuw',
    ieCode: 'IE-2026-001',
    omzetCents: 125050,
    locatie: 'Amsterdam',
    label: 'ITG',
    companyName: 'Acme BV',
    trainerExternalIds: ['1661150001'],
    themaExternalIds: ['5067920001'],
    klantExternalIds: ['9000000001'],
  },
  {
    externalItemId: '5087400002',
    externalBoardId: BOARD_AGENDA,
    externalGroupId: 'topics',
    datum: '2026-04-01',
    tijd: '13:00',
    taal: 'nl',
    duurTraining: 6,
    status: 'Trainer ingepland',
    ieCode: 'IE-2026-002',
    omzetCents: 240000,
    locatie: 'Rotterdam',
    label: 'ITG',
    companyName: 'Acme BV',
    trainerExternalIds: ['1661150002'],
    themaExternalIds: ['5067920002'],
    klantExternalIds: ['9000000001'],
  },
];

export const DEFAULT_QUALIFICATIONS: MondayQualification[] = [
  { trainerExternalId: '1661150001', themaExternalId: '5067920001', qualification: 'groen' },
  { trainerExternalId: '1661150001', themaExternalId: '5067920002', qualification: 'oranje' },
  { trainerExternalId: '1661150002', themaExternalId: '5067920002', qualification: 'groen' },
  { trainerExternalId: '1661150002', themaExternalId: '5067920001', qualification: 'rood' },
];
