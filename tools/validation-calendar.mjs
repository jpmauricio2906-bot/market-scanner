// Explicit NYSE session calendar for this locked historical experiment only.
// Includes the 2018-12-05 national day of mourning; Juneteenth starts in 2022.
const iso=d=>d.toISOString().slice(0,10);
const date=(y,m,d)=>new Date(Date.UTC(y,m-1,d,12));
function nth(y,m,weekday,n){const d=date(y,m,1);d.setUTCDate(1+(weekday-d.getUTCDay()+7)%7+7*(n-1));return iso(d);}
function lastMonday(y,m){const d=date(y,m+1,0);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return iso(d);}
function observed(y,m,day){const d=date(y,m,day);if(d.getUTCDay()===6)d.setUTCDate(day-1);if(d.getUTCDay()===0)d.setUTCDate(day+1);return iso(d);}
function easter(y){const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);return date(y,Math.floor((h+l-7*m+114)/31),(h+l-7*m+114)%31+1);}
export function validationCalendar(){
  const holidays=new Set(['2018-12-05']);
  for(let y=2016;y<=2023;y++){
    const newYear=date(y,1,1); // Saturday New Year is NOT observed on prior Dec31.
    if(newYear.getUTCDay()!==6)holidays.add(observed(y,1,1));
    for(const holiday of [nth(y,1,1,3),nth(y,2,1,3),lastMonday(y,5),observed(y,7,4),nth(y,9,1,1),nth(y,11,4,4),observed(y,12,25)])holidays.add(holiday);
    const goodFriday=easter(y);goodFriday.setUTCDate(goodFriday.getUTCDate()-2);holidays.add(iso(goodFriday));
    if(y>=2022)holidays.add(observed(y,6,19));
  }
  return {firstYear:2016,lastYear:2023,holidays:[...holidays].sort(),sources:[
    'https://www.nyse.com/markets/hours-calendars',
    'https://ir.theice.com/press/news-details/2018/New-York-Stock-Exchange-to-Honor-President-George-H-W-Bush/default.aspx',
    'https://www.nyse.com/publicdocs/ICE_NYSE_2022_Yearly_Trading_Calendar.pdf'
  ]};
}
