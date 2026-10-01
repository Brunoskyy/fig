INSERT INTO ports VALUES
  ('NLRTM', 'Rotterdam', 'NL', 'EU'),
  ('DEHAM', 'Hamburg', 'DE', 'EU'),
  ('BEANR', 'Antwerp', 'BE', 'EU'),
  ('ESVLC', 'Valencia', 'ES', 'EU'),
  ('USNYC', 'New York', 'US', 'NA'),
  ('USSAV', 'Savannah', 'US', 'NA'),
  ('CAHAL', 'Halifax', 'CA', 'NA'),
  ('BRSSZ', 'Santos', 'BR', 'SA'),
  ('BRPEC', 'Pecem', 'BR', 'SA'),
  ('ARBUE', 'Buenos Aires', 'AR', 'SA'),
  ('SGSIN', 'Singapore', 'SG', 'ASIA'),
  ('CNSHA', 'Shanghai', 'CN', 'ASIA');

INSERT INTO lanes VALUES
  ('NLRTM', 'USNYC', '20DV', 182000), ('NLRTM', 'USNYC', '40DV', 268000), ('NLRTM', 'USNYC', '40HC', 284000), ('NLRTM', 'USNYC', '20RF', 391000),
  ('DEHAM', 'USSAV', '20DV', 195000), ('DEHAM', 'USSAV', '40DV', 281000), ('DEHAM', 'USSAV', '40HC', 297500),
  ('BRSSZ', 'NLRTM', '20DV', 214000), ('BRSSZ', 'NLRTM', '40DV', 318000), ('BRSSZ', 'NLRTM', '40HC', 331000), ('BRSSZ', 'NLRTM', '20RF', 446000),
  ('BRPEC', 'ESVLC', '20DV', 176500), ('BRPEC', 'ESVLC', '40HC', 279000),
  ('ARBUE', 'BEANR', '40DV', 334000), ('ARBUE', 'BEANR', '20RF', 468000),
  ('SGSIN', 'NLRTM', '20DV', 241000), ('SGSIN', 'NLRTM', '40DV', 352000), ('SGSIN', 'NLRTM', '40HC', 366000),
  ('CNSHA', 'USSAV', '40HC', 412000), ('CNSHA', 'DEHAM', '40HC', 389000),
  ('CAHAL', 'DEHAM', '20DV', 171000);

INSERT INTO fuel VALUES
  ('2016-01', 0.081), ('2016-02', 0.079), ('2016-03', 0.084), ('2016-04', 0.088),
  ('2016-05', 0.091), ('2016-06', 0.095), ('2016-07', 0.097), ('2016-08', 0.094),
  ('2016-09', 0.090), ('2016-10', 0.087), ('2016-11', 0.089), ('2016-12', 0.093),
  ('2017-01', 0.098), ('2017-03', 0.102);

INSERT INTO customers VALUES
  (1, 'Harbor Lantern Imports', 'std', '2014-03-11'),
  (2, 'Blue Tern Coffee Traders', 'gold', '2013-07-02'),
  (3, 'Kestrel Machine Parts', 'std', '2015-10-19'),
  (4, 'Oriole Fresh Produce', 'gold', '2012-01-23'),
  (5, 'Marlin Textile Co-op', 'std', '2016-04-04');
