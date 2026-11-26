-- Pause only this application's named jobs; other project jobs are untouched.
UPDATE cron.job SET active=false WHERE jobname IN
 ('jb-laundry','jb-meals','jb-meals-continue','jb-automate','jb-automate-continue','jb-push','jb-usage','jb-daily-meal-retention','jb-cron-history-retention');
